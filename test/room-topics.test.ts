// Topics in a room (GitHub 523): who may open, close, change and write in
// one, what a topic may say about itself, and which agents a message in
// it may wake. The refusals are the interesting part: a viewer, a
// collaborator and an agent that is not the lead must all be turned away
// from what is not theirs.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  TOPIC_LIMITS,
  applyDraft,
  cleanBranch,
  cleanFolder,
  newTopic,
  readTopicDraft,
  setStatus,
  topicAgents,
  topicBrief,
  topicForWriting,
  topicPowers,
  type RoomTopic,
} from "../server/room-topics.ts";
import { memberCan } from "../server/member-access.ts";

const members = ["marlow", "ada", "sam"];

describe("who may do what", () => {
  test("the owner and an admin may do everything", () => {
    for (const actor of [{ kind: "owner" } as const, { kind: "admin", personId: "p1" } as const]) {
      assert.deepEqual(topicPowers(actor), { open: true, close: true, edit: true, write: true });
    }
  });

  test("the room's lead opens and closes topics, and changes nothing else", () => {
    assert.deepEqual(topicPowers({ kind: "agent", botId: "marlow", lead: true }), { open: true, close: true, edit: false, write: true });
  });

  test("any other agent only writes", () => {
    assert.deepEqual(topicPowers({ kind: "agent", botId: "ada", lead: false }), { open: false, close: false, edit: false, write: true });
  });

  test("a collaborator writes in open topics and governs none", () => {
    assert.deepEqual(topicPowers({ kind: "collaborator", personId: "p2" }), { open: false, close: false, edit: false, write: true });
  });

  test("a viewer reads and nothing more", () => {
    assert.deepEqual(topicPowers({ kind: "viewer", personId: "p3" }), { open: false, close: false, edit: false, write: false });
  });
});

describe("a member's requests", () => {
  const roleIn = (role: "collaborator" | "viewer" | null) => () => role;
  const never = () => false;

  test("an admin in the room may open and change topics", () => {
    assert.equal(memberCan("POST", "/api/member/rooms/r1/topics", roleIn("collaborator"), never, "admin").ok, true);
    assert.equal(memberCan("PATCH", "/api/member/rooms/r1/topics/t1", roleIn("collaborator"), never, "admin").ok, true);
  });

  test("a member who is not an admin is refused, whatever the room calls them", () => {
    const opened = memberCan("POST", "/api/member/rooms/r1/topics", roleIn("collaborator"), never, "member");
    assert.equal(opened.ok, false);
    assert.equal(!opened.ok && opened.status, 403);
    assert.equal(memberCan("PATCH", "/api/member/rooms/r1/topics/t1", roleIn("collaborator"), never, null).ok, false);
  });

  test("a viewer is refused even as an admin, and a stranger is told there is no room", () => {
    assert.equal(memberCan("POST", "/api/member/rooms/r1/topics", roleIn("viewer"), never, "admin").ok, false);
    const stranger = memberCan("POST", "/api/member/rooms/r1/topics", roleIn(null), never, "admin");
    assert.equal(!stranger.ok && stranger.status, 404);
  });
});

describe("what a topic may say", () => {
  test("a new one needs a title, and a change need not repeat it", () => {
    assert.equal(readTopicDraft({}, members, { creating: true }).ok, false);
    assert.equal(readTopicDraft({ title: "   " }, members, { creating: true }).ok, false);
    assert.equal(readTopicDraft({ category: "Backend" }, members, { creating: false }).ok, true);
  });

  test("the title is trimmed to one line and its length", () => {
    const read = readTopicDraft({ title: `  Auth\n migration ${"x".repeat(200)}` }, members, { creating: true });
    assert.ok(read.ok);
    assert.ok(read.ok && read.draft.title!.startsWith("Auth migration"));
    assert.ok(read.ok && read.draft.title!.length <= TOPIC_LIMITS.title);
  });

  test("its agents are agents of this room, no others", () => {
    assert.equal(readTopicDraft({ title: "t", agents: ["ada", "stranger"] }, members, { creating: true }).ok, false);
    const read = readTopicDraft({ title: "t", agents: ["ada", "ada", "sam"] }, members, { creating: true });
    assert.ok(read.ok);
    assert.deepEqual(read.ok && read.draft.agents, ["ada", "sam"]);
  });

  test("a folder stays inside the room's own", () => {
    assert.equal(cleanFolder("src/auth"), "src/auth/");
    assert.equal(cleanFolder("./docs//research/"), "docs/research/");
    // every way out of the room's folder is refused
    for (const bad of ["/etc", "../secrets", "src/../../x", "~/notes", "C:\\Windows", "a\u0000b"]) {
      assert.equal(cleanFolder(bad), undefined, bad);
    }
    assert.equal(cleanFolder(""), null);
  });

  test("a branch is a name git would take", () => {
    assert.equal(cleanBranch("feature/auth-mw"), "feature/auth-mw");
    for (const bad of ["-rf", "a b", "a..b", "x.lock", "a~1", "a:b", "/lead", "end/", "x@{1}"]) {
      assert.equal(cleanBranch(bad), undefined, bad);
    }
  });

  test("null clears a field, leaving it out keeps it", () => {
    const topic = newTopic("t1", { title: "Auth", category: "Backend", folder: "src/auth/", agents: ["ada"] }, "owner", 1);
    const cleared = applyDraft(topic, { category: null, agents: [] });
    assert.equal(cleared.category, undefined);
    assert.equal(cleared.agents, undefined);
    assert.equal(cleared.folder, "src/auth/");
  });
});

describe("open and closed", () => {
  const topic: RoomTopic = newTopic("t1", { title: "Auth" }, "owner", 1);

  test("closing says who and when, reopening forgets it", () => {
    const closed = setStatus(topic, "closed", "p1", 5);
    assert.equal(closed.status, "closed");
    assert.equal(closed.closedBy, "p1");
    assert.equal(closed.closedAt, 5);
    const open = setStatus(closed, "open", "owner", 6);
    assert.equal(open.status, "open");
    assert.equal(open.closedAt, undefined);
  });

  test("nothing new is said in a closed topic, nor in one that is not there", () => {
    assert.equal(topicForWriting([topic], "t1").ok, true);
    const closed = topicForWriting([setStatus(topic, "closed", "owner")], "t1");
    assert.equal(!closed.ok && closed.status, 409);
    const missing = topicForWriting([topic], "nope");
    assert.equal(!missing.ok && missing.status, 404);
    assert.equal(topicForWriting(undefined, "t1").ok, false);
  });
});

describe("which agents a topic reaches", () => {
  const agents = members.map((id) => ({ id }));

  test("the agents it names, or all of the room's when it names none", () => {
    assert.deepEqual(topicAgents({ ...newTopic("t", { title: "x", agents: ["ada"] }, "owner") }, agents).map((a) => a.id), ["ada"]);
    assert.deepEqual(topicAgents(newTopic("t", { title: "x" }, "owner"), agents).map((a) => a.id), members);
    assert.deepEqual(topicAgents(null, agents).map((a) => a.id), members);
  });

  test("an agent is told where it is and where its work goes", () => {
    const brief = topicBrief(newTopic("t", { title: "Auth migration", folder: "src/auth/", branch: "auth-mw" }, "owner"));
    assert.match(brief, /"Auth migration"/);
    assert.match(brief, /src\/auth\//);
    assert.match(brief, /auth-mw/);
    assert.doesNotMatch(topicBrief(newTopic("t", { title: "Plain" }, "owner")), /branch/);
  });
});
