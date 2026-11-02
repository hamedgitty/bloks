// An OpenID provider of the test's own: a local issuer with its own keys,
// for the web door's sign-in (server/web-door.ts) to talk to the way it
// talks to Authentik or Keycloak. Discovery, keys, an authorize endpoint
// that signs whoever the test says straight in, a token endpoint that
// checks the client secret and the PKCE verifier, and userinfo.
//
// `mode` makes it misbehave in the ways a relying party has to catch: a
// token signed with a key it does not publish, for another application,
// already expired, from another issuer, or signed with the client secret.
import { createHash, createSign, createHmac, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeUser {
  sub: string;
  name?: string;
  email?: string;
  email_verified?: boolean;
  groups?: string[];
}

export type FakeMode = "good" | "wrong-key" | "wrong-audience" | "expired" | "wrong-issuer" | "hs256" | "wrong-nonce";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function signRs256(payload: Record<string, unknown>, key: KeyObject, kid: string): string {
  const head = b64({ alg: "RS256", typ: "JWT", kid });
  const body = b64(payload);
  const sig = createSign("sha256").update(`${head}.${body}`).sign(key).toString("base64url");
  return `${head}.${body}.${sig}`;
}

export async function fakeOidc() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const clientId = "bloks-test";
  // made here, so no secret-shaped text sits in the repository
  const clientSecret = randomBytes(24).toString("hex");
  const state = {
    user: { sub: "owner-sub", name: "Hamed", email: "hamed@example.com", email_verified: true, groups: ["family"] } as FakeUser,
    mode: "good" as FakeMode,
    /** What the token endpoint was last sent, for the PKCE checks. */
    lastTokenRequest: null as Record<string, string> | null,
    tokenCalls: 0,
  };
  const codes = new Map<string, { redirect: string; challenge: string; nonce: string; user: FakeUser }>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return send(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        jwks_uri: `${base}/jwks`,
        userinfo_endpoint: `${base}/userinfo`,
        end_session_endpoint: `${base}/logout`,
      });
    }
    if (url.pathname === "/jwks") return send(200, { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" }] });
    if (url.pathname === "/authorize") {
      const p = url.searchParams;
      if (p.get("client_id") !== clientId || p.get("response_type") !== "code" || p.get("code_challenge_method") !== "S256" || !p.get("code_challenge") || !p.get("nonce")) {
        return send(400, { error: "invalid_request" });
      }
      const code = randomBytes(16).toString("hex");
      codes.set(code, { redirect: p.get("redirect_uri")!, challenge: p.get("code_challenge")!, nonce: p.get("nonce")!, user: { ...state.user } });
      const back = new URL(p.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", p.get("state") ?? "");
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      state.tokenCalls++;
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const form = Object.fromEntries(new URLSearchParams(raw));
      state.lastTokenRequest = form;
      const basic = Buffer.from(String(req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString();
      if (basic !== `${clientId}:${clientSecret}`) return send(401, { error: "invalid_client" });
      const found = codes.get(form.code ?? "");
      codes.delete(form.code ?? "");
      if (!found || found.redirect !== form.redirect_uri) return send(400, { error: "invalid_grant" });
      if (createHash("sha256").update(form.code_verifier ?? "").digest("base64url") !== found.challenge) return send(400, { error: "invalid_grant", error_description: "PKCE" });
      const now = Math.floor(Date.now() / 1000);
      const claims: Record<string, unknown> = {
        iss: state.mode === "wrong-issuer" ? "https://elsewhere.example" : base,
        aud: state.mode === "wrong-audience" ? "someone-else" : clientId,
        exp: state.mode === "expired" ? now - 3600 : now + 300,
        iat: state.mode === "expired" ? now - 4000 : now,
        nonce: state.mode === "wrong-nonce" ? "not-this-one" : found.nonce,
        ...found.user,
      };
      let idToken: string;
      if (state.mode === "hs256") {
        const head = b64({ alg: "HS256", typ: "JWT" });
        const body = b64(claims);
        idToken = `${head}.${body}.${createHmac("sha256", clientSecret).update(`${head}.${body}`).digest("base64url")}`;
      } else {
        idToken = signRs256(claims, state.mode === "wrong-key" ? stranger : privateKey, "k1");
      }
      const access = randomBytes(16).toString("hex");
      accessTokens.set(access, found.user);
      return send(200, { access_token: access, token_type: "Bearer", id_token: idToken, expires_in: 300 });
    }
    if (url.pathname === "/userinfo") {
      const user = accessTokens.get(String(req.headers.authorization ?? "").replace(/^Bearer /, ""));
      return user ? send(200, user) : send(401, { error: "invalid_token" });
    }
    send(404, { error: "not found" });
  });
  const accessTokens = new Map<string, FakeUser>();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer: base,
    clientId,
    clientSecret,
    state,
    /** Signs a token with the provider's own key, for the unit tests. */
    sign: (claims: Record<string, unknown>) => signRs256(claims, privateKey, "k1"),
    publicKey,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
