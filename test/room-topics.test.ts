// Topics in a room (GitHub 523): who may open, close, change and write in
// one, what a topic may say about itself, and which agents a message in
// it may wake. The refusals are the interesting part: a viewer, a
// collaborator and an agent that is not the lead must all be turned away
// from what is not theirs.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  MOVE_REFUSALS,
  TOPIC_LIMITS,
  applyDraft,
  folderHold,
  folderHoldBrief,
  mayMove,
  movable,
  moveWakes,
  routingNote,
  cleanBranch,
  cleanFolder,
  newTopic,
  readTopicDraft,
  scheduledTopic,
  setStatus,
  topicAgents,
  topicBrief,
  topicForWriting,
  topicPowers,
  type RoomTopic,
} from "../server/room-topics.ts";
import { memberCan } from "../server/member-access.ts";
import { topicFolders, type TopicState } from "../src/lib/roomTopics.ts";

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

describe("posts set up ahead of time", () => {
  const topic: RoomTopic = newTopic("t1", { title: "Deploys", category: "DevOps" }, "owner", 1);

  test("go to the main stream when they name no topic, and into an open one when they do", () => {
    assert.deepEqual(scheduledTopic([topic], undefined), { ok: true });
    assert.deepEqual(scheduledTopic([topic], "t1"), { ok: true, topicId: "t1" });
  });

  test("a topic closed or gone since is a failed run with the reason, never a post in the main stream", () => {
    const closed = scheduledTopic([setStatus(topic, "closed", "owner")], "t1");
    assert.equal(closed.ok, false);
    assert.match(!closed.ok ? closed.error : "", /"Deploys" is closed/);
    const gone = scheduledTopic([topic], "nope");
    assert.equal(gone.ok, false);
    assert.equal(scheduledTopic(undefined, "t1").ok, false);
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

describe("folders in the topics bar", () => {
  const t = (id: string, category?: string) => newTopic(id, { title: id, ...(category ? { category } : {}) }, "owner", 1);
  const topics = [t("a", "Research"), t("b", "Backend"), t("c", "Research"), t("d")];
  const idle = new Map<string, TopicState>();

  test("topics sit under their category, the uncategorized last and never folded", () => {
    const folders = topicFolders(topics, idle, null);
    assert.deepEqual(folders.map((f) => [f.category, f.topics.map((x) => x.id)]), [["Research", ["a", "c"]], ["Backend", ["b"]], [null, ["d"]]]);
    assert.equal(folders[2].open, true);
  });

  test("with several folders, a quiet one is folded and a lively one open", () => {
    const states = new Map<string, TopicState>([["b", "waiting"]]);
    const [research, backend] = topicFolders(topics, states, null);
    assert.equal(research.open, false);
    assert.equal(backend.open, true);
    assert.equal(backend.mark, "waiting");
    assert.equal(topicFolders(topics, idle, "c")[0].open, true, "the topic being read keeps its folder open");
  });

  test("one folder alone stays open, and the person's choice wins", () => {
    const one = [t("a", "Research"), t("d")];
    assert.equal(topicFolders(one, idle, null)[0].open, true);
    assert.equal(topicFolders(one, idle, null, { Research: true })[0].open, false);
    assert.equal(topicFolders(topics, idle, null, { Research: false })[0].open, true);
  });

  test("the folder's mark is the loudest inside", () => {
    const states = new Map<string, TopicState>([["a", "working"], ["c", "waiting"]]);
    assert.equal(topicFolders(topics, states, null)[0].mark, "waiting");
    assert.equal(topicFolders(topics, new Map([["a", "working"]]), null)[0].mark, "working");
  });
});

describe("the lead routing work into topics", () => {
  const lead = { kind: "agent", botId: "marlow", lead: true } as const;
  const member = { kind: "agent", botId: "ada", lead: false } as const;

  test("only the lead moves work, and only once the owner lets it", () => {
    assert.deepEqual(mayMove(lead, false), { ok: false, error: MOVE_REFUSALS.notLet });
    assert.deepEqual(mayMove(lead, true), { ok: true });
    assert.deepEqual(mayMove(member, true), { ok: false, error: MOVE_REFUSALS.notLead });
    assert.deepEqual(mayMove({ kind: "collaborator", personId: "p" }, true), { ok: false, error: MOVE_REFUSALS.notLead });
    assert.deepEqual(mayMove({ kind: "viewer", personId: "p" }, true), { ok: false, error: MOVE_REFUSALS.notLead });
    // the owner and an admin need nobody's leave
    assert.deepEqual(mayMove({ kind: "owner" }, false), { ok: true });
    assert.deepEqual(mayMove({ kind: "admin", personId: "p" }, false), { ok: true });
  });

  test("only a person's own words in the main stream move, and each only once", () => {
    const said = { id: "m1", role: "user" as const, kind: "text" };
    assert.deepEqual(movable(said), { ok: true });
    assert.equal(movable(undefined).ok, false);
    for (const odd of [
      { ...said, role: "bot" as const, from: "ada" },
      { ...said, from: "ada" },
      { ...said, kind: "notice" },
      { ...said, deleted: true },
      { ...said, queued: true },
    ]) {
      const verdict = movable(odd);
      assert.equal(verdict.ok, false, JSON.stringify(odd));
    }
    const again = movable({ ...said, topicId: "t1" });
    assert.ok(!again.ok && again.status === 409);
  });

  test("a move wakes the topic's agents, never the one who moved it, and never nobody", () => {
    assert.deepEqual(moveWakes(["marlow", "ada", "sam"], "marlow", undefined), { ok: true, ids: ["ada", "sam"] });
    assert.deepEqual(moveWakes(["marlow", "ada", "sam"], "marlow", ["sam"]), { ok: true, ids: ["sam"] });
    assert.deepEqual(moveWakes(["ada"], null, undefined), { ok: true, ids: ["ada"] });
    assert.deepEqual(moveWakes(["marlow"], "marlow", undefined), { ok: false, error: MOVE_REFUSALS.nobody });
    assert.deepEqual(moveWakes(["marlow", "ada"], "marlow", ["marlow"]), { ok: false, error: MOVE_REFUSALS.nobody });
    assert.deepEqual(moveWakes(["marlow", "ada"], "marlow", ["sam"]), { ok: false, error: MOVE_REFUSALS.stranger });
  });

  test("the lead is told the message, the open topics and the command", () => {
    const topics = [
      newTopic("t1", { title: "Auth", category: "Backend" }, "owner"),
      setStatus(newTopic("t2", { title: "Old work" }, "owner"), "closed", "owner"),
    ];
    const note = routingNote("room-1", "m1", topics, "bloks");
    assert.match(note, /This message is m1/);
    assert.match(note, /"Auth" \(t1, Backend\)/);
    assert.doesNotMatch(note, /Old work/);
    assert.match(note, /bloks topic move room-1 m1 --into <topic-id>/);
    assert.match(note, /--new "<title>"/);
    assert.match(routingNote("room-1", "m1", [], "bloks"), /no open topics yet/);
    assert.doesNotMatch(note, /[\u2013\u2014]/);
  });
});

describe("holding a topic's folder", () => {
  const turn = { engine: "claudeAgent", elsewhere: false, hooksOff: false, shared: false, platform: "darwin" };

  test("Claude Code on this computer is held", () => {
    assert.deepEqual(folderHold(turn), { held: true });
  });

  test("everything else is said as not held, with the reason", () => {
    assert.deepEqual(folderHold({ ...turn, engine: "codex" }), { held: false, gap: "engine" });
    assert.deepEqual(folderHold({ ...turn, elsewhere: true }), { held: false, gap: "elsewhere" });
    assert.deepEqual(folderHold({ ...turn, hooksOff: true }), { held: false, gap: "hooks" });
    assert.deepEqual(folderHold({ ...turn, shared: true }), { held: false, gap: "shared" });
    assert.deepEqual(folderHold({ ...turn, platform: "win32" }), { held: false, gap: "platform" });
  });

  test("the brief says which, and never claims more than is held", () => {
    const held = folderHoldBrief("src/auth/", { held: true });
    assert.match(held, /Bloks holds your file tools to it/);
    assert.match(held, /Commands you run in a shell are not held/);
    for (const gap of ["engine", "elsewhere", "hooks", "shared", "platform"] as const) {
      const brief = folderHoldBrief("src/auth/", { held: false, gap });
      assert.match(brief, /Bloks cannot hold you to it here/);
      assert.doesNotMatch(brief, /[\u2013\u2014]/);
    }
  });
});
