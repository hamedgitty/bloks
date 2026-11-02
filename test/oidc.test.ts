// The OpenID Connect rules on their own (server/oidc.ts): the settings
// from the environment, an ID token checked the way a relying party must,
// and who the claims say somebody is. The flow against a provider is
// test/web-door.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, sign as signRaw, type KeyObject } from "node:crypto";

import { allowed, challengeOf, identityOf, isOwner, oidcConfigFrom, roleFromGroups, safeUrl, verifyWithKey, type OidcConfig } from "../server/oidc.ts";
import { parseListen, webDoorFrom } from "../server/web-door.ts";

const WEB = new URL("https://bloks.example.com");
const base = { BLOKS_OIDC_ISSUER: "https://auth.example.com/application/o/bloks/", BLOKS_OIDC_CLIENT_ID: "bloks", BLOKS_OIDC_CLIENT_SECRET: "made-up-for-this-test" };

function configOf(env: Record<string, string>): OidcConfig {
  const made = oidcConfigFrom(env, WEB);
  assert.ok(made && "config" in made, JSON.stringify(made));
  return made.config;
}

test("the settings come from the environment, and wrong ones say why", () => {
  assert.equal(oidcConfigFrom({}, WEB), null);
  assert.match((oidcConfigFrom({ BLOKS_OIDC_ISSUER: base.BLOKS_OIDC_ISSUER }, WEB) as { error: string }).error, /all three/);
  assert.match((oidcConfigFrom({ ...base, BLOKS_OIDC_ISSUER: "http://auth.example.com" }, WEB) as { error: string }).error, /https/);
  // the callback has to come back here, where the cookie is
  assert.match((oidcConfigFrom({ ...base, BLOKS_OIDC_REDIRECT_URL: "https://elsewhere.example/auth/callback" }, WEB) as { error: string }).error, /has to be https:\/\/bloks\.example\.com\/auth\/callback/);
  // making members of whoever signs in needs a list of who that may be
  assert.match((oidcConfigFrom({ ...base, BLOKS_OIDC_AUTO_CREATE: "1" }, WEB) as { error: string }).error, /ALLOWED_GROUPS or BLOKS_OIDC_ALLOWED_EMAILS/);
  const plain = configOf(base);
  assert.equal(plain.redirectUrl, "https://bloks.example.com/auth/callback");
  assert.deepEqual(plain.scopes, ["openid", "profile", "email"]);
  assert.equal(plain.personClaim, "sub");
  assert.equal(plain.autoCreate, false);
  // groups are asked for once they matter
  const grouped = configOf({ ...base, BLOKS_OIDC_ALLOWED_GROUPS: "family, friends", BLOKS_OIDC_AUTO_CREATE: "true", BLOKS_OIDC_ADMIN_GROUP: "bloks-admins" });
  assert.deepEqual(grouped.allowedGroups, ["family", "friends"]);
  assert.ok(grouped.scopes.includes("groups"));
  assert.equal(grouped.autoCreate, true);
  // scopes as written, with openid always among them
  assert.deepEqual(configOf({ ...base, BLOKS_OIDC_SCOPES: "profile email" }).scopes, ["openid", "profile", "email"]);
  assert.ok(safeUrl("http://127.0.0.1:9000"));
  assert.equal(safeUrl("http://192.168.1.2"), null);
  assert.equal(safeUrl("https://user:pw@auth.example.com"), null);
});

test("the web door's own settings", () => {
  assert.equal(webDoorFrom({}), null);
  assert.match((webDoorFrom({ BLOKS_OIDC_ISSUER: "https://x" }) as { error: string }).error, /BLOKS_WEB_URL is not/);
  assert.match((webDoorFrom({ BLOKS_WEB_URL: "https://bloks.example.com" }) as { error: string }).error, /identity provider/);
  assert.match((webDoorFrom({ ...base, BLOKS_WEB_URL: "https://bloks.example.com/app" }) as { error: string }).error, /nothing after the host/);
  assert.match((webDoorFrom({ ...base, BLOKS_WEB_URL: "http://bloks.lan" }) as { error: string }).error, /https/);
  const ok = webDoorFrom({ ...base, BLOKS_WEB_URL: "https://bloks.example.com/", BLOKS_WEB_LISTEN: "0.0.0.0:8790" });
  assert.ok(ok && "settings" in ok);
  assert.equal(ok.settings.url.origin, "https://bloks.example.com");
  assert.equal(ok.settings.host, "0.0.0.0");
  assert.deepEqual(parseListen("8790"), { host: "127.0.0.1", port: 8790 });
  assert.deepEqual(parseListen("[::]:8790"), { host: "::", port: 8790 });
  assert.equal(parseListen("nope"), null);
  assert.equal(parseListen("0.0.0.0:99999"), null);
});

const ISSUER = "https://auth.example.com/application/o/bloks/";
const now = Date.UTC(2026, 10, 1, 12) as number;
const t0 = Math.floor(now / 1000);
const good = { iss: ISSUER, aud: "bloks", sub: "u1", exp: t0 + 300, iat: t0, nonce: "n-1" };
const want = { issuer: ISSUER, clientId: "bloks", nonce: "n-1", now };

function jwt(alg: string, claims: Record<string, unknown>, key: KeyObject): string {
  const head = Buffer.from(JSON.stringify({ alg, typ: "JWT", kid: "k" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const data = `${head}.${body}`;
  let sig: Buffer;
  if (alg === "RS256") sig = createSign("sha256").update(data).sign(key);
  else if (alg === "ES256") sig = signRaw("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" });
  else if (alg === "PS256") sig = signRaw("sha256", Buffer.from(data), { key, padding: 6, saltLength: 32 });
  else sig = signRaw(null, Buffer.from(data), key);
  return `${data}.${sig.toString("base64url")}`;
}

test("an ID token is believed only when everything about it checks out", () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const ed = generateKeyPairSync("ed25519");
  assert.equal(verifyWithKey(jwt("RS256", good, rsa.privateKey), rsa.publicKey, want).sub, "u1");
  assert.equal(verifyWithKey(jwt("ES256", good, ec.privateKey), ec.publicKey, want).sub, "u1");
  assert.equal(verifyWithKey(jwt("PS256", good, rsa.privateKey), rsa.publicKey, want).sub, "u1");
  assert.equal(verifyWithKey(jwt("EdDSA", good, ed.privateKey), ed.publicKey, want).sub, "u1");

  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const refused = (token: string, why: RegExp, key: KeyObject = rsa.publicKey) => assert.throws(() => verifyWithKey(token, key, want), why);
  refused(jwt("RS256", good, other.privateKey), /signature does not check out/);
  refused(jwt("RS256", { ...good, aud: "someone-else" }, rsa.privateKey), /another application/);
  refused(jwt("RS256", { ...good, aud: ["bloks", "other"] }, rsa.privateKey), /another application/);
  assert.equal(verifyWithKey(jwt("RS256", { ...good, aud: ["bloks", "other"], azp: "bloks" }, rsa.privateKey), rsa.publicKey, want).sub, "u1");
  refused(jwt("RS256", { ...good, exp: t0 - 120 }, rsa.privateKey), /expired/);
  // a minute of clock difference is forgiven
  assert.equal(verifyWithKey(jwt("RS256", { ...good, exp: t0 - 30 }, rsa.privateKey), rsa.publicKey, want).sub, "u1");
  refused(jwt("RS256", { ...good, iss: "https://evil.example/" }, rsa.privateKey), /another issuer/);
  refused(jwt("RS256", { ...good, nonce: "n-2" }, rsa.privateKey), /not issued for this sign-in/);
  refused(jwt("RS256", { ...good, nonce: undefined }, rsa.privateKey), /not issued for this sign-in/);
  refused(jwt("RS256", { ...good, nbf: t0 + 600 }, rsa.privateKey), /not valid yet/);
  refused(jwt("RS256", { ...good, iat: t0 + 600 }, rsa.privateKey), /future/);
  refused(jwt("RS256", { ...good, sub: "" }, rsa.privateKey), /names nobody/);
  // never none, never the client secret
  const head = (alg: string) => Buffer.from(JSON.stringify({ alg })).toString("base64url");
  const body = Buffer.from(JSON.stringify(good)).toString("base64url");
  refused(`${head("none")}.${body}.`, /not one this server accepts/);
  refused(`${head("HS256")}.${body}.abc`, /not one this server accepts/);
  refused("not-a-token", /not a signed token/);
});

test("who the claims say somebody is, and whether they may come in", () => {
  const cfg = configOf({ ...base, BLOKS_OIDC_ALLOWED_GROUPS: "family", BLOKS_OIDC_ALLOWED_EMAILS: "friend@example.org,@example.net", BLOKS_OIDC_ADMIN_GROUP: "bloks-admins", BLOKS_OIDC_OWNER: "owner-sub" });
  const who = (claims: Record<string, unknown>) => identityOf({ sub: "u1", ...claims }, cfg)!;
  assert.equal(who({ name: "Sam" }).name, "Sam");
  assert.equal(who({ preferred_username: "sam" }).name, "sam");
  assert.equal(who({ email: "Sam@Example.com" }).name, "sam");
  assert.equal(identityOf({}, cfg), null);
  // groups, from Keycloak's full paths too
  assert.ok(allowed(who({ groups: ["/family"] }), cfg));
  assert.ok(allowed(who({ groups: "family" }), cfg));
  assert.ok(!allowed(who({ groups: ["guests"] }), cfg));
  // or an address, exactly or at a domain, and never one the provider says is unverified
  assert.ok(allowed(who({ email: "friend@example.org" }), cfg));
  assert.ok(allowed(who({ email: "anyone@example.net" }), cfg));
  assert.ok(!allowed(who({ email: "anyone@example.net", email_verified: false }), cfg));
  assert.ok(!allowed(who({ email: "stranger@example.com" }), cfg));
  // no list lets in whoever the provider does
  assert.ok(allowed(identityOf({ sub: "x" }, configOf(base))!, configOf(base)));
  assert.equal(roleFromGroups(who({ groups: ["family", "bloks-admins"] }), cfg), "admin");
  assert.equal(roleFromGroups(who({ groups: ["family"] }), cfg), "member");
  assert.equal(roleFromGroups(who({}), configOf(base)), null);
  assert.ok(isOwner(identityOf({ sub: "owner-sub" }, cfg)!, cfg));
  assert.ok(!isOwner(who({}), cfg));
  // an owner named by address, by the address claim, only while verified
  const byEmail = configOf({ ...base, BLOKS_OIDC_PERSON_CLAIM: "email", BLOKS_OIDC_OWNER: "Hamed@Example.com" });
  assert.ok(isOwner(identityOf({ sub: "a", email: "hamed@example.com" }, byEmail)!, byEmail));
  assert.ok(!isOwner(identityOf({ sub: "a", email: "hamed@example.com", email_verified: false }, byEmail)!, byEmail));
  // the S256 challenge of RFC 7636's own example
  assert.equal(challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});
