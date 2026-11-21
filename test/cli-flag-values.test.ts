// A flag that takes a value takes the next argument, whatever it starts
// with: `memory --write "---"` once wrote the word "true" and dropped the
// frontmatter (GitHub 540). bin/bloks.mjs is run against a stand-in
// workspace that records what each command sent.
import "./helpers/isolated-env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/bloks.mjs", import.meta.url));
const FRONTMATTER = "---\nname: test\ndescription: a topic\n---\nhello";

interface Sent { method: string; path: string; body: any }
let sent: Sent[] = [];
let url = "";
let home = "";
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    sent.push({ method: req.method!, path: req.url!, body: raw ? JSON.parse(raw) : undefined });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/api/agent/whoami" ? { botId: "bot-me" } : { ok: true }));
  });
});

before(async () => {
  home = mkdtempSync(join(tmpdir(), "bloks-cli-flags-"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => {
  server.close();
  rmSync(home, { recursive: true, force: true });
});

/** One command, and the requests it made other than asking who it is. */
function bloks(...args: string[]): Promise<{ out: any; sent: Sent[] }> {
  sent = [];
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, BLOKS_URL: url, BLOKS_TOKEN: "fixture-token" },
      timeout: 20_000,
    }, (error, stdout) => {
      if (error && !stdout) return reject(error);
      resolve({ out: JSON.parse(stdout), sent: sent.filter((s) => s.path !== "/api/agent/whoami") });
    });
  });
}

test("memory --write keeps text that starts with frontmatter or a dash", async () => {
  const topic = await bloks("memory", "--topic", "some-topic", "--write", FRONTMATTER);
  assert.deepEqual(topic.sent, [{ method: "PUT", path: "/api/bots/bot-me/memory/topics/some-topic.md", body: { text: FRONTMATTER } }]);
  // the order the flags come in does not matter
  const first = await bloks("memory", "--write", "- one\n- two", "--topic", "list");
  assert.deepEqual(first.sent, [{ method: "PUT", path: "/api/bots/bot-me/memory/topics/list.md", body: { text: "- one\n- two" } }]);
  const main = await bloks("memory", "--write", "-1 is not a flag");
  assert.deepEqual(main.sent, [{ method: "PUT", path: "/api/bots/bot-me/memory", body: { text: "-1 is not a flag" } }]);
  // and a word shaped like a flag nobody here has is text too
  const odd = await bloks("memory", "--write", "--verbose notes");
  assert.deepEqual(odd.sent[0]!.body, { text: "--verbose notes" });
});

test("-- before a value hands it over as written, and --flag= does too", async () => {
  const dashed = await bloks("memory", "--topic", "some-topic", "--write", "--", FRONTMATTER);
  assert.deepEqual(dashed.sent[0]!.body, { text: FRONTMATTER });
  // a value that is exactly one of the command's own flags needs one of
  // these, since bare it reads as that flag
  const joined = await bloks("memory", "--topic", "some-topic", "--write=--forget");
  assert.deepEqual(joined.sent, [{ method: "PUT", path: "/api/bots/bot-me/memory/topics/some-topic.md", body: { text: "--forget" } }]);
  const after = await bloks("memory", "--topic", "some-topic", "--write", "--", "--forget");
  assert.deepEqual(after.sent[0]!.body, { text: "--forget" });
});

test("a value flag followed by another of the command's flags is still bare", async () => {
  // --topic with no name is refused rather than taking --write as one
  const refused = await bloks("memory", "--topic", "--write", "text");
  assert.match(refused.out.error, /--topic needs a name/);
  const watch = await bloks("edit-watch", "w1", "--do", "--name", "x");
  assert.match(watch.out.error, /--do needs a value/);
  assert.deepEqual(watch.sent, []);
});

test("every other value flag takes a dashed value the same way", async () => {
  const edit = await bloks("edit-watch", "w1", "--do", "-- check the log", "--name", "-n", "--once=false");
  assert.deepEqual(edit.sent, [{ method: "PATCH", path: "/api/watchers/w1", body: { instruction: "-- check the log", name: "-n", once: false } }]);
  const post = await bloks("post", "--title", "-5 things", "--brief", "--- a brief");
  assert.deepEqual(post.sent, [{ method: "POST", path: "/api/jobs", body: { title: "-5 things", brief: "--- a brief" } }]);
  const secret = await bloks("secret", "Stripe", "key", "--hint", "--- from the dashboard");
  assert.deepEqual(secret.sent, [{ method: "POST", path: "/api/bots/bot-me/secrets", body: { name: "Stripe key", hint: "--- from the dashboard" } }]);
  const routine = await bloks("routine", "--prompt", "- check the inbox", "--time", "09:00");
  assert.equal(routine.sent[0]!.body.prompt, "- check the inbox");
});

test("say and tab take a dashed task or title, and -- ends their flags", async () => {
  const said = await bloks("say", "ada", "--task", "-fix", "--", "--now", "is", "a", "word", "here");
  assert.deepEqual(said.sent, [{ method: "POST", path: "/api/bots/ada/messages", body: { text: "--now is a word here", task: "-fix" } }]);
  const still = await bloks("say", "ada", "--now", "check", "this");
  assert.deepEqual(still.sent[0]!.body, { text: "check this", now: true });
  const tab = await bloks("tab", "me", "--title", "--- notes", "hello");
  assert.deepEqual(tab.sent, [{ method: "POST", path: "/api/agent/conversations", body: { to: "me", text: "hello", title: "--- notes" } }]);
  const literal = await bloks("tab", "me", "--", "--title", "is", "the", "message");
  assert.deepEqual(literal.sent[0]!.body, { to: "me", text: "--title is the message" });
});
