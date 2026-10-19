// Files shared into a conversation (GitHub 310): an agent shares one file
// from anywhere on this computer with its own command, nested and
// unchanged files open by name, a path in a reply resolves to the file it
// names, and nothing outside an agent's files is ever served.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { startHarness } from "./helpers/server.ts";

test("an agent shares a file, and a person opens it by card, by link or by path, and nothing else", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-shared-files-"));
  const out = join(home, "said.json");
  const cli = join(home, "fake-claude.mjs");
  // A stand-in for Claude Code that, told SHARE <args>, runs the real
  // `bloks share` with the turn's own credential, and writes down what it
  // answered.
  writeFileSync(
    cli,
    `#!${process.execPath}
import { renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const [first] = process.argv.slice(2);
if (first === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (first === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let input = "";
process.stdin.on("data", (c) => (input += c));
((go) => { let line = ""; const take = (c) => { line += c; while (line.includes(String.fromCharCode(10))) { const at = line.indexOf(String.fromCharCode(10)); const next = line.slice(0, at); line = line.slice(at + 1); if (!next.trim() || JSON.parse(next).type !== "user") continue; input = next; process.stdin.off("data", take); go(); return; } }; process.stdin.on("data", take); })(async () => {
  const asked = input.match(/SHARE ([A-Za-z0-9+\\/=]+)/);
  if (asked) {
    const args = JSON.parse(Buffer.from(asked[1], "base64").toString("utf8"));
    const ran = spawnSync(process.execPath, [process.env.BLOKS_CLI, "share", ...args], { env: process.env, encoding: "utf8" });
    writeFileSync(${JSON.stringify(out)} + ".tmp", ran.stdout || JSON.stringify({ error: ran.stderr })); renameSync(${JSON.stringify(out)} + ".tmp", ${JSON.stringify(out)});
  }
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }));
});
`,
    { mode: 0o755 },
  );
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });

  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Producer" }) });
  await h.fetch(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }),
  });
  const files = join(home, ".bloks", "artifacts", bot.id);
  mkdirSync(join(files, "reports"), { recursive: true });
  // there before any turn, a folder down: never swept up as a card
  writeFileSync(join(files, "reports", "q3 summary.md"), "# Q3\n\nAll up.");
  // somewhere else entirely, the kind of file an agent makes in a project
  const elsewhere = join(home, "project", "renders");
  mkdirSync(elsewhere, { recursive: true });
  const clip = Buffer.alloc(300_000, 7);
  writeFileSync(join(elsewhere, "demo clip.mp4"), clip);
  // a secret beside the agent's files, and links trying to reach it
  writeFileSync(join(home, "secret.txt"), "the key");
  symlinkSync(join(home, "secret.txt"), join(files, "escape.txt"));
  symlinkSync(join(home, "project"), join(files, "outside"));
  symlinkSync(join(files, "reports", "q3 summary.md"), join(files, "latest.md"));

  const share = async (...args: string[]) => {
    rmSync(out, { force: true });
    await h.fetch(`/api/bots/${bot.id}/messages`, {
      method: "POST",
      // the arguments as base64, which crosses the engine's JSON unescaped
      body: JSON.stringify({ text: `SHARE ${Buffer.from(JSON.stringify(args)).toString("base64")}` }),
    });
    for (let i = 0; i < 300 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(out), "the turn never ran the command");
    return JSON.parse(readFileSync(out, "utf8"));
  };
  const cards = async () =>
    ((await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id).messages as any[]).filter((m) => m.kind === "artifact");
  const settled = async () => {
    for (let i = 0; i < 200; i++) {
      const b = (await h.json("/api/bots")).bots.find((x: any) => x.id === bot.id);
      if (!b.busy && !b.tasks.some((x: any) => x.busy)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  // ── a file from elsewhere on the computer ──
  const shared = await share(join(elsewhere, "demo clip.mp4"));
  assert.equal(shared.ok, true, JSON.stringify(shared));
  assert.deepEqual(shared.artifact, { name: "demo clip.mp4", mime: "video/mp4", size: clip.length });
  assert.equal(shared.href, `/api/bots/${bot.id}/artifacts/demo%20clip.mp4`);
  assert.equal(shared.markdown, `[demo clip.mp4](${shared.href})`);
  await settled();
  // one card, not a second one from the sweep at the end of the turn
  assert.deepEqual((await cards()).map((m) => m.artifact.name), ["demo clip.mp4"]);
  // copied in, the original untouched, and only that one file
  assert.deepEqual(readdirSync(elsewhere), ["demo clip.mp4"]);
  assert.ok(!readdirSync(files).some((n) => n.startsWith(".incoming")), "a staging file was left behind");

  const whole = await h.fetch(shared.href);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("accept-ranges"), "bytes");
  assert.equal(Buffer.from(await whole.arrayBuffer()).length, clip.length);
  // seeking: a header range, and the same through the query for Bloks Cloud
  const part = await h.fetch(shared.href, { headers: { range: "bytes=1000-1999" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 1000-1999/${clip.length}`);
  assert.equal((await part.arrayBuffer()).byteLength, 1000);
  const piece = await h.fetch(`${shared.href}?range=299000-`);
  assert.equal(piece.status, 206);
  assert.equal((await piece.arrayBuffer()).byteLength, 1000);
  assert.equal((await h.fetch(shared.href, { headers: { range: "bytes=999999-" } })).status, 416);

  // the same name again is a second file, not the first one replaced
  const again = await share(join(elsewhere, "demo clip.mp4"));
  assert.equal(again.artifact.name, "demo clip (2).mp4");
  // a folder of its own, by --as
  const named = await share(join(elsewhere, "demo clip.mp4"), "--as", "videos/launch.mov");
  assert.equal(named.artifact.name, "videos/launch.mov");
  assert.equal(named.artifact.mime, "video/quicktime");
  await settled();

  // ── a file already in its files, a folder down, unchanged ──
  const nested = await share(join(files, "reports", "q3 summary.md"));
  assert.equal(nested.ok, true, JSON.stringify(nested));
  assert.equal(nested.artifact.name, "reports/q3 summary.md");
  assert.equal(nested.href, `/api/bots/${bot.id}/artifacts/reports%2Fq3%20summary.md`);
  await settled();
  assert.ok((await cards()).some((m) => m.artifact.name === "reports/q3 summary.md"));
  // and it opens with its folder written either way
  assert.equal(await (await h.fetch(nested.href)).text(), "# Q3\n\nAll up.");
  assert.equal(await (await h.fetch(`/api/bots/${bot.id}/artifacts/reports/q3%20summary.md`)).text(), "# Q3\n\nAll up.");

  // a folder is not a file, and a missing file is said plainly
  assert.match((await share(elsewhere)).error, /one file, not a folder/);
  assert.match((await share(join(home, "nope.pdf"))).error, /no file at/);

  // ── nothing outside the agent's files is served ──
  for (const name of [
    "..%2F..%2Fconfig.json",
    "reports%2F..%2F..%2F..%2Fsecret.txt",
    "%2e%2e%2F%2e%2e%2Fsecret.txt",
    "%252e%252e%252Fsecret.txt",
    "escape.txt",
    "outside%2Frenders%2Fdemo%20clip.mp4",
    ".incoming-x",
    "reports",
    "%E0%A4%A",
  ]) {
    const res = await h.fetch(`/api/bots/${bot.id}/artifacts/${name}`);
    assert.ok(res.status === 404 || res.status === 400, `${name} answered ${res.status}`);
    assert.doesNotMatch(await res.text(), /the key/);
  }
  // a link that stays inside is fine
  assert.equal(await (await h.fetch(`/api/bots/${bot.id}/artifacts/latest.md`)).text(), "# Q3\n\nAll up.");

  // ── a path in a reply, resolved ──
  const resolve = (raw: string) => h.fetch(`/api/artifacts/resolve?path=${encodeURIComponent(raw)}`);
  const byPath = await resolve(join(files, "reports", "q3 summary.md"));
  assert.equal(byPath.status, 200);
  assert.deepEqual(await byPath.json(), {
    botId: bot.id,
    artifact: { name: "reports/q3 summary.md", mime: "text/markdown", size: 13 },
    href: nested.href,
  });
  // a file: URL and an encoded path are the same file
  assert.equal((await (await resolve(pathToFileURL(join(files, "reports", "q3 summary.md")).href)).json()).artifact.name, "reports/q3 summary.md");
  assert.equal((await (await resolve(join(files, "reports", "q3%20summary.md"))).json()).artifact.name, "reports/q3 summary.md");
  // the route itself, with this computer's address or without
  assert.equal((await (await resolve(`${h.url}${shared.href}`)).json()).artifact.name, "demo clip.mp4");
  // and nothing else: the file it was copied from, a link out, a secret,
  // a climb out of the agent's files
  for (const raw of [
    join(elsewhere, "demo clip.mp4"),
    join(files, "escape.txt"),
    join(home, "secret.txt"),
    `${files}/../../secret.txt`,
    "/etc/hosts",
    "relative/name.pdf",
    `/api/bots/${bot.id}/artifacts/escape.txt`,
  ]) {
    const res = await resolve(raw);
    assert.equal(res.status, 404, raw);
    const body = await res.json();
    assert.equal(body.shared, false);
    assert.match(body.error, /not shared/);
  }

  // ── what the person can list and share from here ──
  const listed = (await h.json(`/api/bots/${bot.id}/artifacts`)).files.map((f: any) => f.name).sort();
  assert.ok(listed.includes("reports/q3 summary.md"));
  assert.ok(listed.includes("videos/launch.mov"));
  assert.ok(!listed.some((n: string) => n.includes("secret")));
  const bad = await h.fetch(`/api/bots/${bot.id}/artifacts?name=${encodeURIComponent("../out.txt")}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: "x",
  });
  assert.equal(bad.status, 400);
  const hidden = await h.fetch(`/api/bots/${bot.id}/artifacts?name=${encodeURIComponent("notes/.env")}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: "x",
  });
  assert.equal(hidden.status, 400);
  // through a link that leads out, nothing is written
  const through = await h.fetch(`/api/bots/${bot.id}/artifacts?name=${encodeURIComponent("outside/planted.txt")}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: "x",
  });
  assert.equal(through.status, 400);
  assert.ok(!existsSync(join(home, "project", "planted.txt")));

  // ── a paired phone opens what is shared, and shares nothing in ──
  await h.fetch("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  const started = await h.json("/api/pair/start", { method: "POST" });
  const claimed = await h.json("/api/pair/claim", {
    method: "POST",
    body: JSON.stringify({ credential: started.token, device: "test phone" }),
  });
  const phone = await h.fetchRemote(`/api/artifacts/resolve?path=${encodeURIComponent(join(files, "latest.md"))}`, { token: claimed.token });
  assert.equal(phone.status, 200);
  assert.equal(phone.body.artifact.name, "latest.md");
  const upload = await h.fetchRemote(`/api/bots/${bot.id}/artifacts`, {
    method: "POST",
    token: claimed.token,
    body: JSON.stringify({ name: "latest.md" }),
  });
  assert.equal(upload.status, 403);
});
