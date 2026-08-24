// What an agent may do with a credential of its own, and what it may not.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  AgentTokens,
  NEVER,
  RULES,
  TOKEN_TTL_MS,
  TURN_BUDGET,
  allows,
  capabilities,
  cliBriefing,
  matches,
  runsAProcess,
} from "../server/agent-cli.ts";

const ME = "bot-me";
const SOMEONE_ELSE = "bot-other";

describe("the shape of a rule", () => {
  test(":me is this agent and nobody else", () => {
    assert.equal(matches("/api/bots/:me/memory", `/api/bots/${ME}/memory`, ME), true);
    assert.equal(matches("/api/bots/:me/memory", `/api/bots/${SOMEONE_ELSE}/memory`, ME), false);
  });

  test(":id is anyone, but still one path part", () => {
    assert.equal(matches("/api/bots/:id/messages", `/api/bots/${SOMEONE_ELSE}/messages`, ME), true);
    assert.equal(matches("/api/bots/:id/messages", "/api/bots/a/b/messages", ME), false);
    assert.equal(matches("/api/bots/:id/messages", "/api/bots//messages", ME), false);
  });

  test("a longer path is not the same path", () => {
    assert.equal(matches("/api/bots", "/api/bots/x", ME), false);
    assert.equal(matches("/api/bots/:id/messages", "/api/bots/x", ME), false);
  });
});

describe("what an agent can do", () => {
  test("it can ask who it is, which is the command line's own route", () => {
    // the guard runs before any route does, so a route nobody listed is
    // a route nobody reaches, however special it is
    assert.equal(allows(ME, "GET", "/api/agent/whoami").ok, true);
  });

  test("the things the job was posted for", () => {
    // hire a teammate, open a room, file a routine, put work on the board
    assert.equal(allows(ME, "POST", "/api/bots").ok, true);
    assert.equal(allows(ME, "POST", "/api/bloks").ok, true);
    assert.equal(allows(ME, "POST", "/api/routines").ok, true);
    assert.equal(allows(ME, "POST", "/api/jobs").ok, true);
    assert.equal(allows(ME, "POST", `/api/bots/${SOMEONE_ELSE}/messages`).ok, true);
  });

  test("its own memory, and nobody else's", () => {
    assert.equal(allows(ME, "GET", `/api/bots/${ME}/memory`).ok, true);
    assert.equal(allows(ME, "PUT", `/api/bots/${ME}/memory`).ok, true);
    const refused = allows(ME, "GET", `/api/bots/${SOMEONE_ELSE}/memory`);
    assert.equal(refused.ok, false);
    assert.match(refused.reason ?? "", /only read and write its own/);
  });

  test("its own settings, and nobody else's", () => {
    assert.equal(allows(ME, "PATCH", `/api/bots/${ME}`).ok, true);
    assert.equal(allows(ME, "PATCH", `/api/bots/${SOMEONE_ELSE}`).ok, false);
  });

  test("a query string does not smuggle anything past the rules", () => {
    assert.equal(allows(ME, "GET", "/api/bots?messages=0").ok, true);
    assert.equal(allows(ME, "GET", "/api/config?x=/api/bots").ok, false);
  });

  test("a trailing slash is the same path", () => {
    assert.equal(allows(ME, "GET", "/api/bots/").ok, true);
    assert.equal(allows(ME, "GET", "/api/config/").ok, false);
  });
});

describe("what an agent cannot do", () => {
  test("nothing that holds a key, a device or the record", () => {
    // the point of the credential being narrower than the person's: a
    // prompt is an input, and what steers an agent should not reach these
    for (const path of NEVER) {
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        const verdict = allows(ME, method, path);
        assert.equal(verdict.ok, false, `${method} ${path} should be shut`);
        assert.match(verdict.reason ?? "", /not something an agent can reach/);
      }
      assert.equal(allows(ME, "GET", `${path}/anything/at/all`).ok, false);
    }
  });

  test("it cannot delete an agent, its own or anyone's", () => {
    assert.equal(allows(ME, "DELETE", `/api/bots/${ME}`).ok, false);
    assert.equal(allows(ME, "DELETE", `/api/bots/${SOMEONE_ELSE}`).ok, false);
  });

  test("it cannot open a shell or read another agent's terminal", () => {
    assert.equal(allows(ME, "POST", `/api/bots/${ME}/terminal`).ok, false);
    assert.equal(allows(ME, "GET", `/api/bots/${SOMEONE_ELSE}/terminal/stream`).ok, false);
  });

  test("a refusal says what would have worked instead", () => {
    // the caller is a model, and "no" with no direction is a turn spent
    // trying the same thing five more ways
    const wrongVerb = allows(ME, "DELETE", "/api/jobs");
    assert.equal(wrongVerb.ok, false);
    assert.match(wrongVerb.reason ?? "", /allows GET, POST for an agent, not DELETE/);

    const unknown = allows(ME, "GET", "/api/nonsense");
    assert.match(unknown.reason ?? "", /not on the list of things an agent can do/);
  });

  test("every rule is one of the methods the guard understands", () => {
    const inEveryRoom = () => true;
    for (const rule of RULES) {
      assert.ok(["GET", "POST", "PUT", "PATCH", "DELETE"].includes(rule.method), rule.path);
      assert.ok(rule.why.length > 5, `${rule.path} should say what it is for`);
      assert.equal(allows(ME, rule.method, rule.path.replace(/:me|:id|:room/g, ME), inEveryRoom).ok, true);
    }
  });
});

// An agent has a credential for its own turn, and until now that
// credential reached every room in the workspace. Which rooms an agent is
// in is the difference between a colleague and a broadcaster.
describe("reading one skill", () => {
  test("an agent can read a skill it was told the name of", () => {
    // the other half of keeping long skills out of the prompt: naming one
    // without a way to fetch it would be losing the instruction
    assert.equal(allows(ME, "GET", "/api/skills/release-notes").ok, true);
    assert.equal(allows(ME, "GET", "/api/skills").ok, true);
  });

  test("reading is not writing", () => {
    assert.equal(allows(ME, "DELETE", "/api/skills/release-notes").ok, false);
    assert.equal(allows(ME, "POST", "/api/skills").ok, false);
  });
});

describe("the rooms an agent is in", () => {
  const inRoom = (id: string) => id === "room-mine";

  test("it can speak in a room it is in", () => {
    assert.equal(allows(ME, "POST", "/api/bloks/room-mine/messages", inRoom).ok, true);
    assert.equal(allows(ME, "PATCH", "/api/bloks/room-mine", inRoom).ok, true);
  });

  test("it cannot speak in a room it is not in", () => {
    const verdict = allows(ME, "POST", "/api/bloks/room-theirs/messages", inRoom);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason ?? "", /only speak in and change the rooms it is in/);
  });

  test("the refusal says it is about membership, not about the route", () => {
    // an agent told "that is not allowed" tries another route; an agent
    // told which room it is in asks to be added instead
    const verdict = allows(ME, "PATCH", "/api/bloks/room-theirs", inRoom);
    assert.doesNotMatch(verdict.reason ?? "", /not on the list/);
  });

  test("with no rooms at all, nothing about a room is reachable", () => {
    assert.equal(allows(ME, "POST", "/api/bloks/anything/messages").ok, false);
    // and the list of rooms itself still is, because knowing who is here
    // is how an agent addresses somebody by name
    assert.equal(allows(ME, "GET", "/api/bloks").ok, true);
  });

  test("a room it is in is still not a room it may delete", () => {
    const verdict = allows(ME, "DELETE", "/api/bloks/room-mine", inRoom);
    assert.equal(verdict.ok, false);
  });
});

describe("the credential itself", () => {
  test("it names one agent and one turn", () => {
    const tokens = new AgentTokens();
    const minted = tokens.mint(ME, "task-1", 1_000);
    assert.match(minted.token, /^blk_/);
    const who = tokens.identify(minted.token, 2_000);
    assert.equal(who?.botId, ME);
    assert.equal(who?.taskId, "task-1");
  });

  test("two mints are two different credentials", () => {
    const tokens = new AgentTokens();
    const a = tokens.mint(ME, "task-1", 1);
    const b = tokens.mint(ME, "task-1", 1);
    assert.notEqual(a.token, b.token);
    assert.ok(a.token.length > 30, "a guessable credential is not a credential");
  });

  test("it stops working when the turn does", () => {
    const tokens = new AgentTokens();
    const minted = tokens.mint(ME, "task-1", 1_000);
    const other = tokens.mint(SOMEONE_ELSE, "task-2", 1_000);
    tokens.revokeTask("task-1");
    assert.equal(tokens.identify(minted.token, 1_100), null);
    assert.ok(tokens.identify(other.token, 1_100), "somebody else's turn is not affected");
  });

  test("it expires even if nobody revokes it", () => {
    const tokens = new AgentTokens();
    const minted = tokens.mint(ME, "task-1", 1_000);
    assert.ok(tokens.identify(minted.token, 1_000 + TOKEN_TTL_MS - 1));
    assert.equal(tokens.identify(minted.token, 1_000 + TOKEN_TTL_MS), null);
  });

  test("a deleted agent's credentials go with it", () => {
    const tokens = new AgentTokens();
    const mine = tokens.mint(ME, "task-1", 1);
    const theirs = tokens.mint(SOMEONE_ELSE, "task-2", 1);
    tokens.revokeBot(ME);
    assert.equal(tokens.identify(mine.token, 2), null);
    assert.ok(tokens.identify(theirs.token, 2));
  });

  test("nothing and nonsense are nobody", () => {
    const tokens = new AgentTokens();
    for (const bad of [null, undefined, "", "blk_made-up", "Bearer x"]) {
      assert.equal(tokens.identify(bad, Date.now()), null);
    }
  });

  test("a turn can only change so much, so two agents cannot loop", () => {
    // reading is free; the budget is about an agent messaging an agent
    // that messages back, which without a ceiling runs until the money
    // does
    const tokens = new AgentTokens();
    const minted = tokens.mint(ME, "task-1", 1);
    for (let i = 0; i < TURN_BUDGET; i++) {
      assert.equal(tokens.spend(minted), true, `change ${i + 1} should be allowed`);
    }
    assert.equal(tokens.spend(minted), false, "the budget should run out");
    assert.ok(tokens.identify(minted.token, 2), "the credential still identifies it, it just cannot spend");

    // and the next turn starts fresh
    const next = tokens.mint(ME, "task-2", 1);
    assert.equal(tokens.spend(next), true);
  });

  test("expired credentials do not pile up", () => {
    const tokens = new AgentTokens();
    tokens.mint(ME, "a", 0);
    tokens.mint(ME, "b", 0);
    assert.equal(tokens.size, 2);
    tokens.sweep(TOKEN_TTL_MS + 1);
    assert.equal(tokens.size, 0);
  });
});

describe("who gets a credential at all", () => {
  test("only an engine that runs a process, because that is how it is handed over", () => {
    for (const kind of ["claudeAgent", "codex", "antigravity", "opencode", "grokCli"]) {
      assert.equal(runsAProcess(kind), true, kind);
    }
    // an HTTP engine has nowhere to put it and no shell to spend it from
    for (const kind of ["openaiCompat", "boxAgent", "somethingNew"]) {
      assert.equal(runsAProcess(kind), false, kind);
    }
  });
});

describe("what the agent is told", () => {
  test("short, and it names the command", () => {
    const briefing = cliBriefing('node "/opt/bloks/bin/bloks.mjs"');
    assert.match(briefing, /\/opt\/bloks\/bin\/bloks\.mjs/);
    assert.match(briefing, /help/);
    assert.ok(briefing.length < 500, "a paragraph in every prompt competes with the request");
  });

  test("what it can do is the rules, not a second list to keep in step", () => {
    assert.deepEqual(capabilities(), RULES.map((rule) => rule.why));
  });
});
