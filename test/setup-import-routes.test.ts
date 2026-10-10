// Bring your setup, through the real server: the look answers only this
// computer and never an agent, nothing is written until an import, and
// each ticked item lands where the person would have put it by hand.
//
// The harness runs with HOME set to a throwaway folder, and the other
// tools' files are written into that folder, never read from a real home.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";

import { allows, NEVER } from "../server/agent-cli.ts";
import { startHarness, type Harness } from "./helpers/server.ts";

const SECRETS = ["sk-ant-api03-ROUTESROUTESROUTES0123456789", "ghp_routesroutesroutesroutes0123456789", "sk-ant-oat01-NEVERREADNEVERREAD999"];

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
      mcpServers: { github: { command: "npx", args: ["-y", "server-github"], env: { GITHUB_TOKEN: "ghp_routesroutesroutesroutes0123456789" } } },
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

  test("nothing from the network may look or import", async () => {
    for (const method of ["GET", "POST"]) {
      const remote = await h.fetchRemote("/api/setup-import", { method, body: method === "POST" ? "{}" : undefined });
      assert.ok(remote.status === 401 || remote.status === 403, `${method} answered ${remote.status}`);
    }
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
