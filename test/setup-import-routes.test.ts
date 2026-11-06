// Bring your setup, through the real server: the look answers the owner,
// at this computer or on one of their own paired devices, and never an
// agent or a member; nothing is written until an import, and each ticked
// item lands where the person would have put it by hand. What is read is
// always the server's own computer, which `where` names (GitHub 397).
//
// The harness runs with HOME set to a throwaway folder, and the other
// tools' files are written into that folder, never read from a real home.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";

import { allows, NEVER } from "../server/agent-cli.ts";
import { JoinClient } from "../server/join-client.ts";
import { startHarness, type Harness } from "./helpers/server.ts";
import { teamPlan } from "./helpers/team-plan.ts";
import { makeZip } from "./helpers/zip.ts";

const SECRETS = ["sk-ant-api03-ROUTESROUTESROUTES0123456789", "ghp" + "_routesroutesroutesroutes0123456789", "sk-ant-oat01-NEVERREADNEVERREAD999"];

function write(home: string, path: string, text: string) {
  const file = join(home, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function fixture(home: string) {
  write(home, ".claude/CLAUDE.md", "Keep answers short.\nMy key: sk-ant-api03-ROUTESROUTESROUTES0123456789\n");
  write(home, ".claude/.credentials.json", JSON.stringify({ accessToken: "sk-ant-oat01-NEVERREADNEVERREAD999" }));
  write(home, ".claude/skills/standup/SKILL.md", "---\nname: Standup\ndescription: Write the daily standup\n---\n\nList yesterday, today, blockers.\n");
  write(
    home,
    ".claude.json",
    JSON.stringify({
      mcpServers: { github: { command: "npx", args: ["-y", "server-github"], env: { GITHUB_TOKEN: "ghp" + "_routesroutesroutesroutes0123456789" } } },
    }),
  );
  write(home, ".claude/settings.json", JSON.stringify({ permissions: { deny: ["Bash(git push --force:*)"] } }));
  write(home, ".openclaw/workspace/MEMORY.md", "- The office closes at six.\n");
  write(home, ".openclaw/workspace/USER.md", "- Lives in Lisbon\n");
}

type Review = {
  fresh: number;
  sources: Array<{
    id: string;
    items: Array<{ key: string; kind: string; digest: string; picked: boolean; status: string; suggested: { to: string; botId?: string } }>;
  }>;
};

const picksOf = (review: Review, also: (key: string) => boolean = () => false) =>
  review.sources.flatMap((s) =>
    s.items.filter((i) => i.picked || also(i.key)).map((i) => ({ key: i.key, digest: i.digest, to: i.suggested.to, botId: i.suggested.botId })),
  );

describe("bring your setup, over HTTP", () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
    fixture(h.home);
  });
  after(async () => {
    await h?.stop();
  });

  test("an agent can never reach it, whatever its credential", () => {
    assert.ok(NEVER.includes("/api/setup-import"));
    for (const method of ["GET", "POST"]) assert.equal(allows("some-agent", method, "/api/setup-import").ok, false);
  });

  test("nothing unpaired from the network may look or import", async () => {
    for (const [method, path] of [["GET", "/api/setup-import"], ["POST", "/api/setup-import"], ["GET", "/api/setup-import/where"]]) {
      const remote = await h.fetchRemote(path, { method, body: method === "POST" ? "{}" : undefined });
      assert.ok(remote.status === 401 || remote.status === 403, `${method} ${path} answered ${remote.status}`);
    }
  });

  test("at this computer, it says the setup is read here", async () => {
    const where = await h.json("/api/setup-import/where");
    assert.equal(where.here, true);
    assert.equal(typeof where.computer, "string");
  });

  test("looking finds what is there, shows no secrets, and writes nothing", async () => {
    const res = await h.fetch("/api/setup-import");
    assert.equal(res.status, 200);
    const text = await res.text();
    for (const secret of SECRETS) assert.equal(text.includes(secret), false, `${secret} reached the window`);
    const review = JSON.parse(text) as Review;
    assert.deepEqual(review.sources.map((s) => s.id), ["claude", "openclaw"]);
    assert.equal(existsSync(join(h.home, ".bloks", "setup-import.json")), false);
    assert.deepEqual((await h.json("/api/mcp-servers")).servers, []);
  });

  test("importing the ticked items puts each where it belongs, attached to nothing", async () => {
    const review = (await h.json("/api/setup-import")) as Review;
    const picks = picksOf(review, (key) => key.startsWith("claude:rule:"));
    const res = await h.fetch("/api/setup-import", { method: "POST", body: JSON.stringify({ picks }) });
    assert.equal(res.status, 200);
    const outcome = await res.json();
    assert.deepEqual(outcome.results.filter((r: { ok: boolean }) => !r.ok), []);
    assert.equal(outcome.created.length, 2, "a new agent for Claude Code and one for OpenClaw");

    const { bots } = await h.json("/api/bots");
    const claudeAgent = bots.find((b: { name: string }) => b.name === "Claude Code agent");
    assert.match(claudeAgent.description, /Keep answers short\.\nMy key: \[removed\]/);
    const claw = bots.find((b: { name: string }) => b.name === "OpenClaw agent");

    // memory went through the journal, so it can be undone from the Memory panel
    const memory = await h.json(`/api/bots/${claw.id}/memory`);
    assert.match(memory.text, /## From OpenClaw: MEMORY\.md\n\n- The office closes at six\./);
    const { entries } = await h.json(`/api/bots/${claw.id}/memory/journal`);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].by, "you");
    const undo = await h.fetch(`/api/bots/${claw.id}/memory/journal/${entries[0].id}/undo`, { method: "POST" });
    assert.equal(undo.status, 200);

    const { skills } = await h.json("/api/skills");
    assert.ok(skills.some((s: { id: string }) => s.id === "standup"));
    assert.ok(bots.every((b: { skillIds?: string[] }) => !(b.skillIds ?? []).includes("standup")), "no agent has the skill until the person attaches it");

    const { servers } = await h.json("/api/mcp-servers");
    assert.deepEqual(
      servers.map((s: { name: string; needs: string[] }) => [s.name, s.needs]),
      [["github", ["GITHUB_TOKEN"]]],
    );
    assert.ok(bots.every((b: { mcpServers?: string[] }) => !(b.mcpServers ?? []).length), "no agent has the server");

    const { rules } = await h.json("/api/rules");
    assert.deepEqual(rules.map((r: { effect: string; field: string; op: string; value: string }) => [r.effect, r.field, r.op, r.value]), [
      ["deny", "command", "contains", "git push --force"],
    ]);
    const { notes } = await h.json("/api/profile/notes");
    assert.deepEqual(notes.map((n: { text: string; state: string }) => [n.text, n.state]), [["Lives in Lisbon", "suggested"]]);

    const config = await import("node:fs").then((fs) => fs.readFileSync(join(h.home, ".bloks", "config.json"), "utf8"));
    for (const secret of SECRETS) {
      assert.equal(config.includes(secret), false, `${secret} was written to the config`);
      assert.equal(h.logs().includes(secret), false, `${secret} was logged`);
    }
  });

  test("importing again adds nothing a second time", async () => {
    const before = await h.json("/api/bots");
    const review = (await h.json("/api/setup-import")) as Review;
    // the memory undone above is the one thing not there any more
    assert.deepEqual(
      review.sources.flatMap((s) => s.items.filter((i) => i.status !== "imported").map((i) => i.key)),
      ["openclaw:memory:MEMORY.md"],
    );
    const outcome = await h.json("/api/setup-import", {
      method: "POST",
      body: JSON.stringify({ picks: picksOf(review, () => true) }),
    });
    assert.deepEqual(
      outcome.results.map((r: { key: string; did: string }) => [r.key, r.did]).filter(([, did]: [string, string]) => did !== "unchanged"),
      [["openclaw:memory:MEMORY.md", "added"]],
    );
    assert.equal(outcome.created.length, 0, "it goes back to the agent it went to before");
    const after = await h.json("/api/bots");
    assert.equal(after.bots.length, before.bots.length);
    assert.equal((await h.json("/api/mcp-servers")).servers.length, 1);
    assert.equal((await h.json("/api/rules")).rules.length, 1);
    assert.equal(outcome.review.fresh, 0);
  });

  test("a server's missing value is filled in here, and never read back", async () => {
    const [server] = (await h.json("/api/mcp-servers")).servers;
    const res = await h.fetch(`/api/mcp-servers/${server.id}`, {
      method: "PATCH",
      body: JSON.stringify({ env: { GITHUB_TOKEN: "filled-by-the-person-123", LD_PRELOAD: "/tmp/evil.so" } }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).needs, []);
    const listed = await h.fetch("/api/mcp-servers").then((r) => r.text());
    assert.equal(listed.includes("filled-by-the-person-123"), false);
    const saved = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(join(h.home, ".bloks", "config.json"), "utf8")));
    assert.deepEqual(saved.mcpServers[0].env, { GITHUB_TOKEN: "filled-by-the-person-123" }, "only a name it already had is filled");

    // and a second import keeps it
    const review = (await h.json("/api/setup-import")) as Review;
    await h.json("/api/setup-import", { method: "POST", body: JSON.stringify({ picks: picksOf(review, () => true) }) });
    assert.deepEqual((await h.json("/api/mcp-servers")).servers[0].needs, []);
  });
});

// A workspace on a server with no screen is reached only from the owner's
// paired devices, so that is where its setup is brought over from: read on
// the server, reviewed on the device, written on the server. A member's
// device and a member's credential are refused, as an agent's is above.
test("the owner's own device brings a setup over from the server's computer; a member cannot", { timeout: 120_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-setup-remote-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const licence = await teamPlan();
  t.after(() => licence.close());
  fixture(home);
  mkdirSync(join(home, ".bloks"));
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ remote: { enabled: true }, profile: { name: "Owner" }, ...licence.config }));
  const h = await startHarness({ HOME: home, ...licence.env, BLOKS_COMPUTER_NAME: "Fixture Server" });
  t.after(() => h.stop());

  // the owner's phone or laptop, paired
  await h.fetch("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  const started = await h.json("/api/pair/start", { method: "POST" });
  const paired = await h.fetchRemote("/api/pair/claim", { method: "POST", body: JSON.stringify({ code: started.code, device: "Owner's MacBook" }) });
  const owner = paired.body?.token as string;
  assert.ok(owner, "the fixture device did not pair");

  // named before anything is read, and named as not the device asking
  const where = await h.fetchRemote("/api/setup-import/where", { token: owner });
  assert.equal(where.status, 200);
  assert.deepEqual(where.body, { computer: "Fixture Server", here: false });

  // the same review as at the server itself, scrubbed the same way
  const look = await h.fetchRemote("/api/setup-import", { token: owner });
  assert.equal(look.status, 200);
  const review = look.body as Review;
  assert.deepEqual(review.sources.map((s) => s.id), ["claude", "openclaw"]);
  for (const secret of SECRETS) assert.equal(JSON.stringify(review).includes(secret), false, `${secret} reached the device`);
  assert.deepEqual(review, await h.json("/api/setup-import"));
  assert.equal(existsSync(join(home, ".bloks", "setup-import.json")), false, "looking wrote something");

  // a member: their device never reaches the owner's route, and their
  // credential on this computer is taken at its word
  const lan = new URL(h.url).host;
  const made = await h.json("/api/workspace/invites", { method: "POST", body: JSON.stringify({ role: "admin", name: "Sam" }) });
  const client = new JoinClient(() => "http://127.0.0.1:9");
  const found = (await client.lookup(`${made.invite.link}~${lan}`)) as any;
  assert.ok(found.ok, JSON.stringify(found));
  await client.claim(found.session, { name: "Sam" });
  assert.equal((await h.fetch(`/api/workspace/requests/${made.invite.id}/approve`, { method: "POST" })).status, 200);
  const sam = ((await client.status(found.session)) as any).credentials as { deviceToken: string };
  for (const [method, path] of [["GET", "/api/setup-import/where"], ["GET", "/api/setup-import"], ["POST", "/api/setup-import"]]) {
    const body = method === "POST" ? JSON.stringify({ picks: picksOf(review) }) : undefined;
    const there = await h.fetchRemote(path, { method, token: sam.deviceToken, body });
    assert.notEqual(there.status, 200, `a member's device reached ${method} ${path}`);
    const here = await h.fetch(path, { method, headers: { authorization: `Bearer ${sam.deviceToken}` }, body });
    assert.equal(here.status, 403, `a member's credential on this computer reached ${method} ${path}`);
  }
  assert.equal(existsSync(join(home, ".bloks", "setup-import.json")), false, "a member's import wrote something");

  // the owner's import, from the device: written on the server
  const picks = picksOf(review);
  const brought = await h.fetchRemote("/api/setup-import", { method: "POST", token: owner, body: JSON.stringify({ picks }) });
  assert.equal(brought.status, 200, JSON.stringify(brought.body));
  assert.deepEqual(brought.body.results.filter((r: { ok: boolean }) => !r.ok), []);
  assert.ok(brought.body.results.length > 0);
  assert.ok(existsSync(join(home, ".bloks", "setup-import.json")), "the import was not recorded on the server");
  const { skills } = await h.json("/api/skills");
  assert.ok(skills.some((s: { id: string }) => s.id === "standup"), "the skill did not land on the server");
});

// The newer sources through the real server: a subagent, a server whose
// key the person says to copy, and a Telegram bot from OpenClaw, against
// a stand-in for Telegram that answers on loopback. Then the undo route
// takes all of it back.
describe("bringing agents, keys and a chat app over, and taking them back", () => {
  const TOKEN = "777000:AAH-fixture-telegram-token-routes";
  const GITHUB = "ghp" + "_copiedcopiedcopiedcopied0123456789";
  let h: Harness;
  let telegram: Server;
  before(async () => {
    // getMe for the one token it knows; anything else is refused, as Telegram would
    telegram = createServer((req, res) => {
      const ok = req.url === `/bot${TOKEN}/getMe`;
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? { ok: true, result: { id: 777000, username: "claw_fixture_bot", is_bot: true } } : { ok: false }));
    });
    await new Promise<void>((done) => telegram.listen(0, "127.0.0.1", done));
    const port = (telegram.address() as AddressInfo).port;
    h = await startHarness({ BLOKS_TELEGRAM_API: `http://127.0.0.1:${port}` });
    write(h.home, ".claude/agents/reviewer.md", "---\nname: Reviewer\ndescription: Reviews code.\ntools: Read, Grep\n---\n\nReview carefully.\n");
    write(h.home, ".claude.json", JSON.stringify({ mcpServers: { github: { command: "npx", args: ["server-github"], env: { GITHUB_TOKEN: GITHUB } } } }));
    write(h.home, ".openclaw/openclaw.json", `// JSON5\n{ channels: { telegram: { botToken: '${TOKEN}', }, }, }`);
    write(h.home, ".openclaw/workspace/SOUL.md", "Calm.\n");
  });
  after(async () => {
    await h?.stop();
    await new Promise((done) => telegram?.close(done));
  });

  type Item = { key: string; kind: string; digest: string; suggested: { to: string; botId?: string }; secrets?: Array<{ id: string; copyFrom?: string }> };
  const all = (review: { sources: Array<{ items: Item[] }> }) => review.sources.flatMap((s) => s.items);

  test("the values are named, never sent, and copied only where the person said", async () => {
    const res = await h.fetch("/api/setup-import");
    const text = await res.text();
    assert.equal(text.includes(TOKEN), false);
    assert.equal(text.includes(GITHUB), false);
    const review = JSON.parse(text) as { sources: Array<{ items: Item[] }>; lastRun: unknown };
    assert.equal(review.lastRun, null);
    const item = (key: string) => all(review).find((i) => i.key === key)!;
    assert.deepEqual(item("claude:mcp:github").secrets, [{ id: "env:GITHUB_TOKEN", name: "GITHUB_TOKEN", where: "env", copyFrom: "~/.claude.json" }]);
    const picks = ["claude:agent:reviewer", "claude:mcp:github", "openclaw:channel:telegram"].map((key) => ({
      key,
      digest: item(key).digest,
      to: item(key).suggested.to,
      ...(item(key).suggested.botId ? { botId: item(key).suggested.botId } : {}),
      ...(key.includes(":mcp:") ? { secrets: { "env:GITHUB_TOKEN": { copy: true } } } : {}),
      ...(key.includes(":channel:") ? { secrets: { "token:botToken": { copy: true } } } : {}),
    }));
    const outcome = await h.json("/api/setup-import", { method: "POST", body: JSON.stringify({ picks }) });
    assert.deepEqual(outcome.results.filter((r: { ok: boolean }) => !r.ok), []);
    assert.ok(outcome.run?.id, "the import can be undone");
    assert.equal(outcome.review.lastRun.id, outcome.run.id);

    const { bots } = await h.json("/api/bots");
    const reviewer = bots.find((b: { name: string }) => b.name === "Reviewer");
    assert.equal(reviewer.title, "Reviews code.");
    assert.equal(reviewer.description, "Review carefully.");
    const { rules } = await h.json("/api/rules");
    assert.ok(rules.length > 0 && rules.every((r: { botId?: string; effect: string }) => r.botId === reviewer.id && r.effect === "deny"));

    // the key landed in the server list, and only there
    const { servers } = await h.json("/api/mcp-servers");
    assert.deepEqual(servers[0].needs, []);
    const listed = await h.fetch("/api/mcp-servers").then((r) => r.text());
    assert.equal(listed.includes(GITHUB), false);
    const config = readFileSync(join(h.home, ".bloks", "config.json"), "utf8");
    assert.ok(config.includes(GITHUB), "the copied value is saved where keys are");
    for (const file of ["setup-import.json", "setup-import-runs.json"]) {
      const kept = readFileSync(join(h.home, ".bloks", file), "utf8");
      assert.equal(kept.includes(GITHUB) || kept.includes(TOKEN), false, `a value reached ${file}`);
    }
    assert.equal(h.logs().includes(GITHUB) || h.logs().includes(TOKEN), false, "a value was logged");

    // the bot is saved for the agent made for OpenClaw, switched off
    const claw = bots.find((b: { name: string }) => b.name === "OpenClaw agent");
    const status = await h.json(`/api/bots/${claw.id}/telegram`);
    assert.equal(status.configured, true);
    assert.equal(status.enabled, false);
    assert.equal(status.username, "claw_fixture_bot");
    assert.equal(JSON.stringify(status).includes(TOKEN), false);
  });

  test("an agent can never undo one, and the owner's undo takes it all back", async () => {
    assert.equal(allows("some-agent", "POST", "/api/setup-import/undo").ok, false);
    const { lastRun } = await h.json("/api/setup-import");
    const remote = await h.fetchRemote("/api/setup-import/undo", { method: "POST", body: JSON.stringify({ runId: lastRun.id }) });
    assert.ok(remote.status === 401 || remote.status === 403);

    const res = await h.fetch("/api/setup-import/undo", { method: "POST", body: JSON.stringify({ runId: lastRun.id }) });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.deepEqual(out.kept, []);
    assert.equal(out.review.lastRun, null);
    const { bots } = await h.json("/api/bots");
    const live = bots.filter((b: { archivedAt?: number; hidden?: boolean }) => !b.archivedAt && !b.hidden).map((b: { name: string }) => b.name);
    assert.equal(live.includes("Reviewer") || live.includes("OpenClaw agent"), false, "the agents it made are archived");
    assert.deepEqual((await h.json("/api/mcp-servers")).servers, []);
    assert.deepEqual((await h.json("/api/rules")).rules, []);
    const config = readFileSync(join(h.home, ".bloks", "config.json"), "utf8");
    assert.equal(config.includes(TOKEN), false, "the bot's token is gone with it");
    assert.equal(config.includes(GITHUB), false);

    const twice = await h.fetch("/api/setup-import/undo", { method: "POST", body: JSON.stringify({ runId: lastRun.id }) });
    assert.equal(twice.status, 409);
    assert.equal((await h.fetch("/api/setup-import/undo", { method: "POST", body: JSON.stringify({ runId: "nope" }) })).status, 404);
  });
});

// An OpenBot transfer file is the one thing that travels from the window:
// picked there, sent in parts as an attachment is, so it crosses Bloks
// Cloud and reaches a server with no screen, and judged whole on arrival.
// A file it would refuse is never kept.
describe("an OpenBot transfer file, sent from the window", () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h?.stop();
  });

  // it says it is a picture, and is taken as the file it is anyway
  const send = async (bytes: Buffer, name = "my openbot.zip") => {
    const started = await h.fetch("/api/setup-import/transfer/uploads", { method: "POST", body: JSON.stringify({ name, size: bytes.length, type: "image/png" }) });
    assert.equal(started.status, 201);
    const { id, partSize, parts } = await started.json();
    for (let i = 0; i < parts; i++) {
      const put = await h.fetch(`/api/setup-import/transfer/uploads/${id}/${i}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(bytes.subarray(i * partSize, (i + 1) * partSize)),
      });
      assert.equal(put.status, 200);
    }
    return h.fetch(`/api/setup-import/transfer/uploads/${id}/finish`, { method: "POST" });
  };
  const kept = () => join(h.home, ".bloks", "setup-transfer", "openbot-transfer.zip");
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  const transfer = makeZip([
    {
      name: "openbot-transfer.json",
      data: JSON.stringify({
        format: "openbot-instance-transfer",
        version: 1,
        agents: [
          {
            key: "ada",
            name: "Ada",
            instructions: "Be thorough.",
            memories: [{ text: "Likes tea", essential: true }],
            routines: [{ name: "Daily", prompt: "Say hello", time: "09:15", days: [1, 3] }],
          },
        ],
      }),
    },
    { name: "agents/ada/avatar.png", data: png },
    // big enough to need several parts
    { name: "agents/ada/workspace/notes/plan.md", data: "plan ".repeat(200_000), deflate: true },
    { name: "agents/ada/workspace/data.bin", data: Buffer.alloc(500_000, 7) },
  ]);

  test("an agent never reaches it, nor anyone unpaired", async () => {
    for (const method of ["GET", "DELETE"]) assert.equal(allows("some-agent", method, "/api/setup-import/transfer").ok, false);
    assert.equal(allows("some-agent", "POST", "/api/setup-import/transfer/uploads").ok, false);
    for (const [method, path] of [["GET", "/api/setup-import/transfer"], ["POST", "/api/setup-import/transfer/uploads"], ["DELETE", "/api/setup-import/transfer"]]) {
      const remote = await h.fetchRemote(path, { method, body: method === "POST" ? JSON.stringify({ name: "x.zip", size: 10 }) : undefined });
      assert.ok(remote.status === 401 || remote.status === 403, `${method} ${path} answered ${remote.status}`);
    }
  });

  test("a hostile file is refused and nothing of it is kept", async () => {
    const res = await send(makeZip([{ name: "openbot-transfer.json", data: "{}" }, { name: "../../evil.sh", data: "rm -rf ~" }]));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /That file cannot be read: it holds an entry whose path climbs out of the file/);
    assert.equal(existsSync(kept()), false);
    assert.equal((await h.json("/api/setup-import/transfer")).transfer, null);
    assert.equal((await h.json("/api/setup-import")).transfer, null, "the look says none is being read");
  });

  test("a good one is read, its agent brought over with its parts, taken back, and the file removed", async () => {
    const res = await send(transfer);
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.transfer.name, "my openbot.zip");
    assert.equal(out.transfer.bytes, transfer.length);
    assert.equal(JSON.stringify(out).includes(h.home), false, "where it is kept is never said");
    const source = (out.review as Review).sources.find((s) => s.id === "openbot")!;
    assert.equal((out.review.sources as Array<{ id: string; folder: string }>).find((s) => s.id === "openbot")!.folder, "my openbot.zip");
    const keys = source.items.map((i) => i.key);
    for (const key of ["openbot:agent:ada", "openbot:memory:ada/essential", "openbot:files:ada", "openbot:routine:ada/daily"]) assert.ok(keys.includes(key), key);

    const picks = source.items.map((i) => ({ key: i.key, digest: i.digest, to: i.suggested.to, botId: i.suggested.botId }));
    const imported = await h.json("/api/setup-import", { method: "POST", body: JSON.stringify({ picks }) });
    assert.deepEqual(imported.results.filter((r: { ok: boolean }) => !r.ok), []);
    const { bots } = await h.json("/api/bots");
    const ada = bots.find((b: { name: string }) => b.name === "Ada");
    assert.equal(ada.description, "Be thorough.");
    assert.ok(ada.avatarAt, "with its picture");
    const photo = await h.fetch(`/api/bots/${ada.id}/avatar`);
    assert.equal(photo.headers.get("content-type"), "image/png");
    assert.ok(Buffer.from(await photo.arrayBuffer()).equals(png));
    const folder = join(h.home, ".bloks", "workspaces", ada.id);
    assert.equal(readFileSync(join(folder, "notes", "plan.md"), "utf8"), "plan ".repeat(200_000));
    assert.equal(readFileSync(join(folder, "data.bin")).length, 500_000);
    assert.match((await h.json(`/api/bots/${ada.id}/memory`)).text, /## From OpenBot: Essential memories\n\n- Likes tea/);
    const { routines } = await h.json("/api/routines");
    assert.deepEqual(
      routines.map((r: { targetId: string; name: string; time: string; days: number[]; enabled: boolean }) => [r.targetId, r.name, r.time, r.days, r.enabled]),
      [[ada.id, "Daily", "09:15", [1, 3], false]],
    );

    const undone = await h.json("/api/setup-import/undo", { method: "POST", body: JSON.stringify({ runId: imported.run.id }) });
    assert.deepEqual(undone.kept, []);
    assert.equal(existsSync(join(folder, "notes", "plan.md")), false);
    assert.deepEqual((await h.json("/api/routines")).routines, []);

    const removed = await h.json("/api/setup-import/transfer", { method: "DELETE" });
    assert.equal(removed.transfer, null);
    assert.equal(existsSync(kept()), false);
    assert.equal((removed.review as Review).sources.some((s) => s.id === "openbot"), false);
  });
});
