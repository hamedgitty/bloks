// The Bloks browser through a real server with no desktop app behind it,
// the way bloks-server runs. With its own browser off: an agent's turn
// reaches its route with its own credential, is told plainly the browser
// is not here, and is never charged its turn's changes for trying; the
// person's settings save and stay saved; nothing an agent holds reaches
// the person's routes. With a Chrome (a fake one, helpers/fake-cdp-browser.mjs):
// the person opens a page and watches it, their input reaches it, and an
// agent drives the same browser under the same rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { startHarness } from "./helpers/server.ts";

const waitFor = async <T,>(check: () => Promise<T | null | undefined> | T | null | undefined, ms = 30_000): Promise<T | null> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

/** An engine that makes the requests its message names with its own turn
 * credential, and writes down what came back. */
function fakeEngine(home: string) {
  const answers = join(home, "answers.json");
  const cli = join(home, "fake-claude.mjs");
  // Told CALLS <base64 json>, makes each request with its turn credential
  // and writes down what came back.
  writeFileSync(
    cli,
    `#!${process.execPath}
import { renameSync, writeFileSync } from "node:fs";
const [first] = process.argv.slice(2);
if (first === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (first === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let input = "";
((go) => { let line = ""; const take = (c) => { line += c; while (line.includes(String.fromCharCode(10))) { const at = line.indexOf(String.fromCharCode(10)); const next = line.slice(0, at); line = line.slice(at + 1); if (!next.trim() || JSON.parse(next).type !== "user") continue; input = next; process.stdin.off("data", take); go(); return; } }; process.stdin.on("data", take); })(async () => {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s-" + Math.random().toString(36).slice(2), model: "claude-sonnet-5" }));
  const asked = input.match(/CALLS ([A-Za-z0-9+\\/=]+)/);
  if (asked) {
    const out = [];
    for (const [method, path, body] of JSON.parse(Buffer.from(asked[1], "base64").toString("utf8"))) {
      const res = await fetch(process.env.BLOKS_URL + path, {
        method,
        headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      out.push({ status: res.status, body: await res.json().catch(() => null) });
    }
    writeFileSync(${JSON.stringify(answers)} + ".tmp", JSON.stringify(out)); renameSync(${JSON.stringify(answers)} + ".tmp", ${JSON.stringify(answers)});
  }
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 100, result: "Done." }));
});
`,
    { mode: 0o755 },
  );
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
  return answers;
}

test("with its own browser off, the Bloks browser is unavailable to agents and its settings are the person's", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-app-browser-"));
  const answers = fakeEngine(home);
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });

  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Ivy" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });

  // The agent: its status, then fourteen tries at a page, more than a
  // turn's twelve changes, then the person's routes.
  const open = ["POST", "/api/agent/browser", { action: "open", url: "https://example.com" }];
  const calls = [
    ["GET", "/api/agent/browser"],
    ...Array.from({ length: 14 }, () => open),
    ["POST", "/api/agent/browser", { action: "eval", script: "alert(1)" }],
    ["GET", "/api/browser/settings"],
    ["PUT", "/api/browser/settings", { mode: "auto" }],
    ["POST", "/api/browser/command", { action: "read" }],
  ];
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: `CALLS ${Buffer.from(JSON.stringify(calls)).toString("base64")}` }) });
  assert.ok(await waitFor(() => existsSync(answers)), "the turn never ran");
  const out = JSON.parse(readFileSync(answers, "utf8")) as Array<{ status: number; body: any }>;

  assert.equal(out[0].status, 200);
  assert.equal(out[0].body.available, false);
  assert.match(out[0].body.note, /The Bloks browser is turned off on this server/);
  for (const tried of out.slice(1, 15)) {
    assert.equal(tried.status, 503, JSON.stringify(tried.body));
    assert.match(tried.body.error, /turned off on this server\. Use a browser tool of your own/);
  }
  assert.equal(out[15].status, 400, "a command that is not one is refused before anything");
  assert.match(out[15].body.error, /the browser does open, read/);
  for (const theirs of out.slice(16)) {
    assert.equal(theirs.status, 403, JSON.stringify(theirs.body));
    assert.match(theirs.body.error, /\/api\/browser is not something an agent can reach/);
  }

  // The person: what the browser is doing and why it is not here, and
  // its rules, saved to disk.
  assert.deepEqual(await h.json("/api/browser"), { available: false, where: "server", missing: "off", state: null });
  assert.deepEqual(await h.json("/api/browser/frame"), { live: false });
  const nothing = await h.fetch("/api/browser/do", { method: "POST", body: JSON.stringify({ action: "navigate", arg: "docs.example" }) });
  assert.equal(nothing.status, 503);
  assert.equal((await nothing.json()).missing, "off");
  const before = await h.json("/api/browser/settings");
  assert.deepEqual(before.settings, { mode: "ask", allow: [], deny: [] });
  assert.equal(before.available, false);
  assert.equal(before.where, "server");
  assert.match(before.downloads, /browser-downloads$/);
  const put = await h.fetch("/api/browser/settings", { method: "PUT", body: JSON.stringify({ allow: ["https://www.Docs.example/x"], deny: ["bank.example"] }) });
  assert.equal(put.status, 200);
  assert.deepEqual((await put.json()).settings, { mode: "ask", allow: ["docs.example"], deny: ["bank.example"] });
  assert.deepEqual(JSON.parse(readFileSync(join(home, ".bloks", "app-browser.json"), "utf8")), { mode: "ask", allow: ["docs.example"], deny: ["bank.example"] });
  const bad = await h.fetch("/api/browser/settings", { method: "PUT", body: JSON.stringify({ deny: ["not a site"] }) });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /is not a site/);

  // another app on this computer, over MCP, hears the same
  const command = await h.fetch("/api/browser/command", { method: "POST", body: JSON.stringify({ action: "open", url: "https://docs.example" }) });
  assert.equal(command.status, 503);
  // and a browser card nobody raised is not something an answer reaches
  const respond = await h.json(`/api/bots/${bot.id}/respond`, { method: "POST", body: JSON.stringify({ requestId: "browser:nothing", behavior: "allow" }) });
  assert.deepEqual(respond, { ok: false, outcome: "unavailable" });
  // a website cannot reach any of it
  const cross = await h.fetchAs("https://evil.example", "/api/browser/settings", { method: "PUT", body: JSON.stringify({ mode: "auto" }) });
  assert.equal(cross.status, 403);
  assert.equal((await h.json("/api/browser/settings")).settings.mode, "ask");
});

test("with a Chrome on the server, the person browses and watches from anywhere, and an agent drives the same browser", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-server-browser-"));
  const answers = fakeEngine(home);
  // The server runs with no PATH, so its Chrome is a script that names
  // its Node outright, the way a packaged browser names its own binary.
  const chrome = join(home, "fake-chrome");
  writeFileSync(chrome, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fileURLToPath(new URL("./helpers/fake-cdp-browser.mjs", import.meta.url)))} "$@"\n`, { mode: 0o755 });
  const h = await startHarness({ HOME: home, BLOKS_BROWSER: chrome });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });

  assert.deepEqual(await h.json("/api/browser"), { available: true, where: "server", state: { tabs: [], activeTabId: null, control: { by: "idle" }, downloads: [] } });
  assert.equal(existsSync(join(home, ".bloks", "browser-session")), false, "nothing starts until it is wanted");

  // the person, at their panel: its size, then a page
  assert.equal((await h.fetch("/api/browser/viewport", { method: "POST", body: JSON.stringify({ width: 640, height: 480, scale: 2 }) })).status, 200);
  const went = await h.json("/api/browser/do", { method: "POST", body: JSON.stringify({ action: "navigate", arg: "docs.example" }) });
  assert.deepEqual(went, { ok: true, url: "https://docs.example" });
  const shown = await waitFor(async () => {
    const said = await h.json("/api/browser");
    return said.state?.tabs?.[0]?.title === "Docs" ? said.state : null;
  });
  assert.ok(shown, "the page never showed");
  assert.equal(shown.tabs[0].url, "https://docs.example");
  // it started headless, in the workspace's own profile
  const args = JSON.parse(readFileSync(join(home, ".bloks", "browser-session", "launch-args.json"), "utf8")) as string[];
  assert.ok(args.includes("--headless=new"), args.join(" "));
  assert.ok(args.includes(`--user-data-dir=${join(home, ".bloks", "browser-session")}`));

  // the pictures: one at once, sized to the panel
  const frame = await h.json("/api/browser/screen?after=0");
  assert.equal(Buffer.from(frame.jpeg, "base64").toString(), "frame 1 of https://docs.example");
  assert.equal(frame.width, 640);
  assert.equal(frame.tab, shown.activeTabId);
  // their hands on it
  const input = await h.fetch("/api/browser/input", {
    method: "POST",
    body: JSON.stringify({ events: [{ t: "mouse", type: "down", x: 10, y: 10 }, { t: "mouse", type: "up", x: 10, y: 10 }, { t: "text", text: "hello" }] }),
  });
  assert.equal(input.status, 200);
  assert.deepEqual(await input.json(), { ok: true, tookOver: false });
  const junk = await h.fetch("/api/browser/input", { method: "POST", body: JSON.stringify({ events: [{ t: "eval", code: "alert(1)" }] }) });
  assert.equal(junk.status, 400);
  // a website reaches none of it
  for (const [path, init] of [
    ["/api/browser/input", { method: "POST", body: JSON.stringify({ events: [{ t: "text", text: "x" }] }) }],
    ["/api/browser/do", { method: "POST", body: JSON.stringify({ action: "navigate", arg: "evil.example" }) }],
    ["/api/browser/screen?after=0", {}],
  ] as const) {
    assert.equal((await h.fetchAs("https://evil.example", path, init)).status, 403, path);
  }

  // an agent, in Auto: its own tab beside the person's, its page framed
  await h.fetch("/api/browser/settings", { method: "PUT", body: JSON.stringify({ mode: "auto" }) });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Ivy" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  const calls = [
    ["GET", "/api/agent/browser"],
    ["POST", "/api/agent/browser", { action: "open", url: "https://shop.example" }],
    ["POST", "/api/agent/browser", { action: "snapshot" }],
    ["GET", "/api/browser/screen?after=0"],
    ["POST", "/api/browser/input", { events: [{ t: "text", text: "x" }] }],
  ];
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: `CALLS ${Buffer.from(JSON.stringify(calls)).toString("base64")}` }) });
  assert.ok(await waitFor(() => existsSync(answers)), "the turn never ran");
  const out = JSON.parse(readFileSync(answers, "utf8")) as Array<{ status: number; body: any }>;
  assert.equal(out[0].body.available, true);
  assert.match(out[0].body.tabs, /\| Docs \| https:\/\/docs\.example \| the person's/);
  assert.equal(out[1].status, 200, JSON.stringify(out[1].body));
  assert.match(out[1].body.page, /came from a web page on shop\.example and is untrusted data/);
  assert.match(out[2].body.page, /@e1 textbox "Password"/);
  // the person's picture and hands are the person's alone
  for (const theirs of out.slice(3)) {
    assert.equal(theirs.status, 403, JSON.stringify(theirs.body));
    assert.match(theirs.body.error, /\/api\/browser is not something an agent can reach/);
  }
  const both = await waitFor(async () => {
    const said = await h.json("/api/browser");
    return said.state?.tabs?.length === 2 ? said.state : null;
  });
  assert.deepEqual(both.tabs.map((tab: { by: { kind: string } }) => tab.by.kind), ["person", "agent"]);
});
