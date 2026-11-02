// Signing in with an identity provider of the person's own: OpenID
// Connect, for a server opened in a browser (server/web-door.ts).
//
// The provider is whatever the household or the team already runs for
// everything else (Authentik, Keycloak, Authelia, Google and the like),
// found through its discovery document, so the settings are the five or
// six a self-hosted app always asks for and nothing provider specific.
//
// The flow is the authorization code flow with PKCE, a state and a nonce:
// the browser is sent to the provider with a fresh state (which the
// callback must bring back, once), a nonce (which the ID token must
// carry) and the S256 challenge of a verifier that never leaves this
// server. The code that comes back is traded here, server to server,
// with the client secret and the verifier, and the ID token is believed
// only after its signature checks out against the provider's published
// keys and its issuer, audience, expiry and nonce are right. A token
// signed with the client secret (HS256) is refused: the keys a provider
// publishes are what this file trusts, never a secret it holds itself.
//
// Everything here is about the provider. Who a signed in identity is in
// this workspace, and what it may do, is web-door.ts's to decide.
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature, constants, type JsonWebKeyInput, type KeyObject } from "node:crypto";

// ── settings ───────────────────────────────────────────────────────────

export interface OidcConfig {
  /** As configured. The provider's own spelling (discovery) is what an
   * ID token's issuer is compared with. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  scopes: string[];
  /** Somebody in any of these groups may sign in. */
  allowedGroups: string[];
  /** Or somebody with one of these addresses, or an address at one of
   * these domains ("@example.com"). */
  allowedEmails: string[];
  /** The claim that says who somebody is: one identity is one person. */
  personClaim: string;
  groupsClaim: string;
  /** Make a member of somebody allowed who signs in for the first time. */
  autoCreate: boolean;
  /** Members in this group are admins, the others members, as of each
   * sign in. Null leaves roles to the Members page. */
  adminGroup: string | null;
  /** The person claim's value for the owner, who stays the owner. */
  owner: string | null;
  /** What the button says: "Sign in with <name>". */
  name: string;
}

const list = (raw: string | undefined) =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const on = (raw: string | undefined) => /^(1|true|yes|on)$/i.test((raw ?? "").trim());

/** Whether an address is one a browser may be sent to and a server may
 * call: https, or plain http on this machine only (a test, a laptop). */
export function safeUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    if (url.protocol === "https:") return url;
    if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return url;
    return null;
  } catch {
    return null;
  }
}

/**
 * The provider settings from the environment, or why they are wrong, or
 * null when sign-in is not set up at all. `webUrl` is where the browser
 * opens this server, which the redirect defaults beside.
 */
export function oidcConfigFrom(env: NodeJS.ProcessEnv, webUrl: URL): { config: OidcConfig } | { error: string } | null {
  const issuer = env.BLOKS_OIDC_ISSUER?.trim();
  const clientId = env.BLOKS_OIDC_CLIENT_ID?.trim();
  const clientSecret = env.BLOKS_OIDC_CLIENT_SECRET?.trim();
  if (!issuer && !clientId && !clientSecret) return null;
  if (!issuer || !clientId || !clientSecret) {
    return { error: "Sign-in needs BLOKS_OIDC_ISSUER, BLOKS_OIDC_CLIENT_ID and BLOKS_OIDC_CLIENT_SECRET, all three." };
  }
  if (!safeUrl(issuer)) return { error: "BLOKS_OIDC_ISSUER has to be an https address." };
  const redirect = env.BLOKS_OIDC_REDIRECT_URL?.trim() || new URL("/auth/callback", webUrl).href;
  const redirectUrl = safeUrl(redirect);
  // the callback sets the session cookie, so it has to be this server's
  // own address, where the cookie will be sent back
  if (!redirectUrl || redirectUrl.origin !== webUrl.origin || redirectUrl.pathname !== "/auth/callback") {
    return { error: `BLOKS_OIDC_REDIRECT_URL has to be ${new URL("/auth/callback", webUrl).href}.` };
  }
  const allowedGroups = list(env.BLOKS_OIDC_ALLOWED_GROUPS);
  const allowedEmails = list(env.BLOKS_OIDC_ALLOWED_EMAILS).map((e) => e.toLowerCase());
  const adminGroup = env.BLOKS_OIDC_ADMIN_GROUP?.trim() || null;
  const autoCreate = on(env.BLOKS_OIDC_AUTO_CREATE);
  // Google and the like know everybody: making a member of whoever signs
  // in is only safe with a list of who that may be
  if (autoCreate && !allowedGroups.length && !allowedEmails.length) {
    return { error: "BLOKS_OIDC_AUTO_CREATE needs BLOKS_OIDC_ALLOWED_GROUPS or BLOKS_OIDC_ALLOWED_EMAILS, so not everybody the provider knows becomes a member." };
  }
  const asked = list((env.BLOKS_OIDC_SCOPES ?? "").replace(/\s+/g, ","));
  // groups are asked for when they matter (Authelia sends them only for
  // the scope), and not otherwise: Google refuses a scope it does not know
  const scopes = asked.length ? asked : ["openid", "profile", "email", ...(allowedGroups.length || adminGroup ? ["groups"] : [])];
  if (!scopes.includes("openid")) scopes.unshift("openid");
  const personClaim = env.BLOKS_OIDC_PERSON_CLAIM?.trim() || "sub";
  if (!/^[\w.:-]{1,64}$/.test(personClaim)) return { error: "BLOKS_OIDC_PERSON_CLAIM is the name of a claim, like sub, email or preferred_username." };
  const groupsClaim = env.BLOKS_OIDC_GROUPS_CLAIM?.trim() || "groups";
  if (!/^[\w.:-]{1,64}$/.test(groupsClaim)) return { error: "BLOKS_OIDC_GROUPS_CLAIM is the name of a claim, like groups or roles." };
  const name = (env.BLOKS_OIDC_NAME?.trim() || "single sign-on").slice(0, 40);
  return {
    config: {
      issuer,
      clientId,
      clientSecret,
      redirectUrl: redirectUrl.href,
      scopes,
      allowedGroups,
      allowedEmails,
      personClaim,
      groupsClaim,
      autoCreate,
      adminGroup,
      owner: env.BLOKS_OIDC_OWNER?.trim() || null,
      name,
    },
  };
}

// ── the provider ───────────────────────────────────────────────────────

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
}

export type Jwk = { kty: string; kid?: string; use?: string; alg?: string; [key: string]: unknown };

const trimSlash = (s: string) => s.replace(/\/+$/, "");
const TIMEOUT_MS = 10_000;

async function getJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${new URL(url).host} did not answer with JSON`);
  }
}

/** The provider's discovery document, checked: the endpoints this flow
 * needs, each an address it may use, and an issuer that is the one
 * configured (a slash at the end aside). */
export async function discover(issuer: string): Promise<Discovery> {
  const doc = (await getJson(`${trimSlash(issuer)}/.well-known/openid-configuration`)) as Partial<Discovery> | null;
  if (!doc || typeof doc !== "object") throw new Error("the provider's discovery document is empty");
  if (typeof doc.issuer !== "string" || trimSlash(doc.issuer) !== trimSlash(issuer)) {
    throw new Error(`the provider calls itself ${String(doc.issuer)}, not ${issuer}`);
  }
  for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    if (typeof doc[key] !== "string" || !safeUrl(doc[key] as string)) throw new Error(`the provider's ${key} is missing or not https`);
  }
  for (const key of ["userinfo_endpoint", "end_session_endpoint"] as const) {
    if (doc[key] !== undefined && (typeof doc[key] !== "string" || !safeUrl(doc[key] as string))) delete doc[key];
  }
  return doc as Discovery;
}

/**
 * One provider, with what it published kept for a while: the discovery
 * document for an hour, its keys until a token names one it does not
 * have, which is how a provider rotates them (asked again at most once a
 * minute, so a stream of made-up key ids cannot make this server hammer
 * the provider).
 */
export class OidcProvider {
  private doc: { value: Discovery; at: number } | null = null;
  private keys: { value: Jwk[]; at: number } | null = null;
  readonly config: OidcConfig;
  private readonly now: () => number;
  constructor(config: OidcConfig, now: () => number = Date.now) {
    this.config = config;
    this.now = now;
  }

  async discovery(): Promise<Discovery> {
    if (this.doc && this.now() - this.doc.at < 60 * 60_000) return this.doc.value;
    const value = await discover(this.config.issuer);
    this.doc = { value, at: this.now() };
    return value;
  }

  async jwks(fresh = false): Promise<Jwk[]> {
    if (this.keys && !(fresh && this.now() - this.keys.at > 60_000)) return this.keys.value;
    const doc = await this.discovery();
    const body = (await getJson(doc.jwks_uri)) as { keys?: unknown } | null;
    const value = Array.isArray(body?.keys) ? (body!.keys as unknown[]).filter((k): k is Jwk => Boolean(k) && typeof (k as Jwk).kty === "string") : [];
    this.keys = { value, at: this.now() };
    return value;
  }

  /** Where the browser goes to sign in. */
  async authorizeUrl(flow: { state: string; nonce: string; verifier: string }): Promise<string> {
    const doc = await this.discovery();
    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUrl);
    url.searchParams.set("scope", this.config.scopes.join(" "));
    url.searchParams.set("state", flow.state);
    url.searchParams.set("nonce", flow.nonce);
    url.searchParams.set("code_challenge", challengeOf(flow.verifier));
    url.searchParams.set("code_challenge_method", "S256");
    return url.href;
  }

  /** Trades a code for the provider's tokens, server to server. */
  async exchange(code: string, verifier: string): Promise<{ idToken: string; accessToken: string | null }> {
    const doc = await this.discovery();
    const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: this.config.redirectUrl, code_verifier: verifier });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    // Basic is the default every provider takes; post only for one that
    // says it takes nothing else
    const methods = doc.token_endpoint_auth_methods_supported;
    if (methods && !methods.includes("client_secret_basic") && methods.includes("client_secret_post")) {
      form.set("client_id", this.config.clientId);
      form.set("client_secret", this.config.clientSecret);
    } else {
      const pair = `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`;
      headers.authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
    }
    const body = (await getJson(doc.token_endpoint, { method: "POST", headers, body: form })) as { id_token?: unknown; access_token?: unknown } | null;
    if (typeof body?.id_token !== "string") throw new Error("the provider sent no ID token");
    return { idToken: body.id_token, accessToken: typeof body.access_token === "string" ? body.access_token : null };
  }

  /** The ID token's claims, once everything about it checks out. */
  async verify(idToken: string, nonce: string): Promise<Claims> {
    const doc = await this.discovery();
    const parts = decodeJwt(idToken);
    let key = pickKey(await this.jwks(), parts.header);
    if (!key) key = pickKey(await this.jwks(true), parts.header);
    if (!key) throw new Error("the ID token is signed with a key the provider does not publish");
    return checkIdToken(parts, key, { issuer: doc.issuer, clientId: this.config.clientId, nonce, now: this.now() });
  }

  /**
   * What the userinfo endpoint adds, for a provider that keeps groups or
   * an address out of the ID token (Keycloak without a mapper, say). The
   * ID token's own claims win; userinfo only fills gaps, and only when it
   * is about the same subject.
   */
  async fillIn(claims: Claims, accessToken: string | null): Promise<Claims> {
    const doc = await this.discovery();
    const wanted = [this.config.personClaim, this.config.groupsClaim, "email", "name"];
    if (!accessToken || !doc.userinfo_endpoint || wanted.every((k) => claims[k] !== undefined)) return claims;
    try {
      const info = (await getJson(doc.userinfo_endpoint, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } })) as Claims | null;
      if (!info || info.sub !== claims.sub) return claims;
      return { ...info, ...claims };
    } catch {
      return claims;
    }
  }

  /** Where the browser goes to sign out of the provider too, when it
   * offers that; null otherwise. */
  async endSessionUrl(backTo: string): Promise<string | null> {
    const doc = await this.discovery().catch(() => null);
    if (!doc?.end_session_endpoint) return null;
    const url = new URL(doc.end_session_endpoint);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("post_logout_redirect_uri", backTo);
    return url.href;
  }
}

// ── PKCE, state and nonce ──────────────────────────────────────────────

/** 32 random bytes, base64url: a state, a nonce, a verifier. */
export const randomToken = () => randomBytes(32).toString("base64url");

export function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Two secrets the same, in constant time. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ── the ID token ───────────────────────────────────────────────────────

export type Claims = Record<string, unknown> & { sub?: unknown };

interface Jwt {
  header: { alg?: unknown; kid?: unknown; typ?: unknown };
  payload: Claims;
  signed: Buffer;
  signature: Buffer;
}

function decodeJwt(token: string): Jwt {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("the ID token is not a signed token");
  const read = (s: string) => {
    const value = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("the ID token is malformed");
    return value;
  };
  try {
    return { header: read(parts[0]), payload: read(parts[1]), signed: Buffer.from(`${parts[0]}.${parts[1]}`), signature: Buffer.from(parts[2], "base64url") };
  } catch {
    throw new Error("the ID token is malformed");
  }
}

/** The algorithms a provider's published keys sign with. Never "none",
 * and never HS*: those are signed with the client secret. */
const ALGS: Record<string, { kty: string; hash: string | null; pss?: boolean; curve?: string }> = {
  RS256: { kty: "RSA", hash: "sha256" },
  RS384: { kty: "RSA", hash: "sha384" },
  RS512: { kty: "RSA", hash: "sha512" },
  PS256: { kty: "RSA", hash: "sha256", pss: true },
  PS384: { kty: "RSA", hash: "sha384", pss: true },
  PS512: { kty: "RSA", hash: "sha512", pss: true },
  ES256: { kty: "EC", hash: "sha256", curve: "P-256" },
  ES384: { kty: "EC", hash: "sha384", curve: "P-384" },
  ES512: { kty: "EC", hash: "sha512", curve: "P-521" },
  EdDSA: { kty: "OKP", hash: null },
};

function pickKey(keys: Jwk[], header: Jwt["header"]): KeyObject | null {
  const alg = typeof header.alg === "string" ? ALGS[header.alg] : undefined;
  if (!alg) return null;
  const fits = keys.filter(
    (k) => k.kty === alg.kty && (k.use === undefined || k.use === "sig") && (k.alg === undefined || k.alg === header.alg) && (alg.curve === undefined || k.crv === alg.curve),
  );
  // a key id when the token names one; with none, the provider's only key
  const found = typeof header.kid === "string" ? fits.find((k) => k.kid === header.kid) : fits.length === 1 ? fits[0] : undefined;
  if (!found) return null;
  try {
    return createPublicKey({ key: found as JsonWebKeyInput["key"], format: "jwk" });
  } catch {
    return null;
  }
}

/** How far apart two clocks may be. */
const SKEW_S = 60;

/**
 * An ID token believed, or the reason it is not: the signature against
 * the key, then the claims a relying party must check (OpenID Connect
 * Core 3.1.3.7): issuer, audience (and azp when there are several),
 * expiry, not-before, issued-at, nonce, and a subject.
 */
export function checkIdToken(jwt: Jwt, key: KeyObject, want: { issuer: string; clientId: string; nonce: string; now: number }): Claims {
  const algName = typeof jwt.header.alg === "string" ? jwt.header.alg : "";
  const alg = ALGS[algName];
  if (!alg) throw new Error(`the ID token's algorithm ${algName || "(none)"} is not one this server accepts; have the provider sign with a key (RS256 or ES256)`);
  const ok = verifySignature(
    alg.hash,
    jwt.signed,
    alg.kty === "EC"
      ? { key, dsaEncoding: "ieee-p1363" }
      : alg.pss
        ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }
        : key,
    jwt.signature,
  );
  if (!ok) throw new Error("the ID token's signature does not check out");
  const c = jwt.payload;
  const now = Math.floor(want.now / 1000);
  if (c.iss !== want.issuer) throw new Error("the ID token is from another issuer");
  const aud = typeof c.aud === "string" ? [c.aud] : Array.isArray(c.aud) ? c.aud : [];
  if (!aud.includes(want.clientId)) throw new Error("the ID token is for another application");
  if ((aud.length > 1 || c.azp !== undefined) && c.azp !== want.clientId) throw new Error("the ID token is for another application");
  if (typeof c.exp !== "number" || now > c.exp + SKEW_S) throw new Error("the ID token has expired");
  if (c.nbf !== undefined && (typeof c.nbf !== "number" || now + SKEW_S < c.nbf)) throw new Error("the ID token is not valid yet");
  if (typeof c.iat !== "number" || c.iat > now + SKEW_S) throw new Error("the ID token was issued in the future");
  if (typeof c.nonce !== "string" || !sameSecret(c.nonce, want.nonce)) throw new Error("the ID token was not issued for this sign-in");
  if (typeof c.sub !== "string" || !c.sub) throw new Error("the ID token names nobody");
  return c;
}

/** For the provider's own tests and the harness's: a token decoded and
 * checked with a key in hand. */
export function verifyWithKey(idToken: string, key: KeyObject, want: { issuer: string; clientId: string; nonce: string; now: number }): Claims {
  return checkIdToken(decodeJwt(idToken), key, want);
}

// ── who the claims say somebody is ─────────────────────────────────────

export interface Identity {
  /** The person claim's value: one identity, one person. */
  subject: string;
  name: string;
  email: string | null;
  /** False only when the provider says the address is not verified. */
  emailVerified: boolean;
  groups: string[];
}

const groupKey = (g: string) => g.replace(/^\//, "").toLowerCase();

export function identityOf(claims: Claims, config: OidcConfig): Identity | null {
  const raw = claims[config.personClaim];
  const subject = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
  if (!subject || subject.length > 320) return null;
  const email = typeof claims.email === "string" && claims.email.includes("@") ? claims.email.trim().toLowerCase() : null;
  const g = claims[config.groupsClaim];
  const groups = (Array.isArray(g) ? g : typeof g === "string" ? [g] : []).filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 200);
  const named = [claims.name, claims.preferred_username, claims.given_name, email?.split("@")[0]].find((x): x is string => typeof x === "string" && x.trim().length > 0);
  return { subject, name: named?.trim() ?? "Someone", email, emailVerified: claims.email_verified !== false && claims.email_verified !== "false", groups };
}

/** Whether a provider-side address is the one asked about: an exact
 * address, or any at a domain written "@example.com". */
function emailMatches(email: string, allowed: string[]): boolean {
  const domain = email.slice(email.lastIndexOf("@"));
  return allowed.some((a) => (a.startsWith("@") ? a === domain : a === email));
}

/** Whether the allow lists let this identity in. No list at all lets in
 * whoever the provider does: the provider's own rules for the
 * application are then the whole gate. */
export function allowed(identity: Identity, config: OidcConfig): boolean {
  if (!config.allowedGroups.length && !config.allowedEmails.length) return true;
  const mine = new Set(identity.groups.map(groupKey));
  if (config.allowedGroups.some((g) => mine.has(groupKey(g)))) return true;
  return Boolean(identity.email && identity.emailVerified && emailMatches(identity.email, config.allowedEmails));
}

/** The role the admin group gives, or null when roles are not the
 * provider's to say. */
export function roleFromGroups(identity: Identity, config: OidcConfig): "admin" | "member" | null {
  if (!config.adminGroup) return null;
  return identity.groups.some((g) => groupKey(g) === groupKey(config.adminGroup!)) ? "admin" : "member";
}

/** Whether this identity is the owner. An address only counts when the
 * provider has not said it is unverified. */
export function isOwner(identity: Identity, config: OidcConfig): boolean {
  if (!config.owner) return false;
  const byEmail = config.owner.includes("@");
  if (byEmail && !identity.emailVerified && config.personClaim === "email") return false;
  return byEmail ? identity.subject.toLowerCase() === config.owner.toLowerCase() : identity.subject === config.owner;
}
