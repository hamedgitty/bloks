// A failed read must not become replacement state on the next save.
import assert from "node:assert/strict";
import { after, before, beforeEach, test, type TestContext } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "bloks-read-"));
const data = join(home, ".bloks");
let config: typeof import("../server/config.ts");
let store: typeof import("../server/store.ts");
let people: typeof import("../server/people.ts");
let pairing: typeof import("../server/pairing.ts");
let memory: typeof import("../server/memory-journal.ts");
let factories: Array<{ name: string; file: string; open: () => unknown; text?: string }>;

function closeStore(opened: any) {
  // UsageStore's timer is unref'd, but must not write into a later fixture.
  if (opened?.timer) clearInterval(opened.timer);
}

before(async () => {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  config = await import("../server/config.ts");
  assert.equal(config.DATA_DIR, data);
  store = await import("../server/store.ts");
  people = await import("../server/people.ts");
  pairing = await import("../server/pairing.ts");
  memory = await import("../server/memory-journal.ts");
  const { BlokStore } = await import("../server/bloks.ts");
  const { RoutineStore } = await import("../server/routines.ts");
  const { JobStore } = await import("../server/jobs.ts");
  const { ProjectStore } = await import("../server/projects.ts");
  const { WorkflowStore } = await import("../server/workflows.ts");
  const { SidebarStore } = await import("../server/sidebar.ts");
  const { WebhookStore } = await import("../server/webhooks.ts");
  const { ArtifactCommentStore } = await import("../server/artifact-comments.ts");
  const { PolicyStore } = await import("../server/policy.ts");
  const { ProposalStore } = await import("../server/proposals.ts");
  const { UsageStore } = await import("../server/usage.ts");
  const { TeamLibrary } = await import("../server/team-library.ts");
  const { ProfileNotes } = await import("../server/profile-notes.ts");
  const { TurnLogStore } = await import("../server/engine-report.ts");
  const { TurnsInFlight } = await import("../server/cut-off.ts");
  const { RoomTagQueues } = await import("../server/room-tags.ts");
  const { Rehearsals } = await import("../server/rehearsals.ts");
  const { Checkpoints } = await import("../server/checkpoints.ts");
  const { SessionCosts } = await import("../server/drivers/session-costs.ts");
  const file = (name: string) => join(data, name);
  factories = [
    { name: "agents", file: file("bots.json"), open: () => new store.Store(() => ({ instanceId: "codex", model: "default" })) },
    { name: "rooms", file: file("bloks.json"), open: () => new BlokStore() },
    { name: "config load", file: file("config.json"), text: "{}", open: () => config.loadConfig() },
    { name: "config save", file: file("config.json"), text: "{}", open: () => config.saveConfig({ telegram: { offset: 2 } }) },
    { name: "config disconnect", file: file("config.json"), text: "{}", open: () => config.disconnectProvider("openai") },
    { name: "routines", file: file("routines.json"), open: () => new RoutineStore() },
    { name: "jobs", file: file("jobs.json"), open: () => new JobStore() },
    { name: "projects", file: file("projects.json"), open: () => new ProjectStore() },
    { name: "workflows", file: file("workflows.json"), open: () => new WorkflowStore() },
    { name: "sidebar", file: file("sidebar.json"), text: "{}", open: () => new SidebarStore(file("sidebar.json")) },
    { name: "webhooks", file: file("webhooks.json"), open: () => new WebhookStore() },
    { name: "artifact comments", file: file("artifact-comments.json"), open: () => new ArtifactCommentStore() },
    { name: "policy", file: file("rules.json"), open: () => new PolicyStore() },
    { name: "proposals", file: file("proposals.json"), open: () => new ProposalStore() },
    { name: "usage", file: file("usage.json"), open: () => new UsageStore() },
    { name: "team library", file: file("team-library.json"), open: () => new TeamLibrary() },
    { name: "profile notes", file: file("profile-notes.json"), open: () => new ProfileNotes(file("profile-notes.json")) },
    { name: "engine turns", file: file("engine-turns.json"), open: () => new TurnLogStore(file("engine-turns.json")) },
    { name: "cut-off turns", file: file("turns-in-flight.json"), open: () => new TurnsInFlight(file("turns-in-flight.json")) },
    { name: "room queues", file: file("room-lines.json"), open: () => new RoomTagQueues(file("room-lines.json")) },
    { name: "rehearsals", file: file("rehearsals/index.json"), open: () => new Rehearsals(file("rehearsals")) },
    { name: "checkpoints", file: file("checkpoints/index.json"), open: () => new Checkpoints(file("checkpoints")) },
    { name: "session costs", file: file("claude-session-costs.json"), text: "{}", open: () => new SessionCosts(data) },
    { name: "people", file: file("people.json"), text: "{}", open: () => people.people() },
    { name: "pairing links", file: file("pair-links.json"), open: () => pairing.createPairLink() },
    { name: "memory history", file: file("memory-journal/agent.json"), open: () => new memory.MemoryJournal(file("memory-journal"), () => file("workspace")).list("agent") },
  ];
});
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => {
  people.resetPeopleCache();
  rmSync(data, { recursive: true, force: true });
  mkdirSync(data, { recursive: true, mode: 0o700 });
});

function refuseRead(t: TestContext, file: string, code: string) {
  const real = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (path: any, ...args: any[]) => {
    if (path === file) throw Object.assign(new Error("planted-secret must stay private"), { code });
    return (real as any)(path, ...args);
  });
  syncBuiltinESMExports();
  const restore = () => { t.mock.restoreAll(); syncBuiltinESMExports(); };
  t.after(restore);
  return restore;
}

test("cold transcript read and append refuse without caching empty; retry retains every row", (t) => {
  const file = join(data, "messages-lane.json");
  const original = JSON.stringify([{ id: "one", at: 1, role: "user", kind: "text", text: "first" }, { id: "two", at: 2, role: "bot", kind: "text", text: "second" }]);
  writeFileSync(file, original);
  const saved = new store.Store(() => ({ instanceId: "codex", model: "default" }));
  const restore = refuseRead(t, file, "EACCES");
  assert.throws(() => saved.messagesFor("lane"), /messages-lane\.json \(EACCES\)/);
  assert.throws(() => saved.appendMessage("lane", { role: "user", kind: "text", text: "third" }), /EACCES/);
  assert.equal((saved as any).messages.has("lane"), false);
  restore();
  assert.equal(readFileSync(file, "utf8"), original);
  saved.appendMessage("lane", { role: "user", kind: "text", text: "third" });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).map((m: any) => m.text), ["first", "second", "third"]);
  assert.deepEqual(readdirSync(data).filter((f) => f.includes("corrupt")), []);
});

test("config read-before-save refuses every IO error without losing unrelated settings", async (t) => {
  for (const code of ["EACCES", "EMFILE", "EIO", "ENOMEM"]) {
    await t.test(code, (t) => {
      const file = join(data, "config.json");
      const original = '{"providers":{"openai":{"key":"planted-secret"}},"telegram":{"offset":1}}';
      writeFileSync(file, original, { mode: 0o600 });
      const restore = refuseRead(t, file, code);
      assert.throws(() => config.saveConfig({ telegram: { offset: 2 } }), (error: any) => {
        assert.match(error.message, new RegExp(code));
        assert.doesNotMatch(error.stack, /planted-secret/);
        assert.equal(error.cause, undefined);
        return true;
      });
      restore();
      assert.equal(readFileSync(file, "utf8"), original);
      config.saveConfig({ telegram: { offset: 2 } });
      const next = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(next.providers.openai.key, "planted-secret");
      assert.equal(next.telegram.offset, 2);
    });
  }
});

test("every saved-state loader refuses unreadable existing data", async (t) => {
  for (const item of factories) {
    await t.test(item.name, (t) => {
      mkdirSync(join(item.file, ".."), { recursive: true });
      const text = item.text ?? "[]";
      writeFileSync(item.file, text);
      people.resetPeopleCache();
      const restore = refuseRead(t, item.file, "EACCES");
      let opened: any;
      try {
        assert.throws(() => { opened = item.open(); }, /EACCES/);
      } finally {
        closeStore(opened);
        restore();
      }
      assert.equal(readFileSync(item.file, "utf8"), text);
      assert.equal(readdirSync(join(item.file, "..")).some((f) => f.includes(".corrupt-")), false);
    });
  }
});

test("every saved-state loader keeps malformed bytes before starting empty and permits a missing file", async (t) => {
  for (const item of factories) {
    await t.test(item.name, (t) => {
      mkdirSync(join(item.file, ".."), { recursive: true });
      const original = '{"planted-secret":';
      writeFileSync(item.file, original, { mode: 0o600 });
      people.resetPeopleCache();
      const warn = t.mock.method(console, "warn", () => {});
      closeStore(item.open());
      const aside = readdirSync(join(item.file, "..")).filter((f) => f.startsWith(item.file.split(/[\\/]/).pop()! + ".corrupt-"));
      assert.equal(aside.length, 1);
      assert.equal(readFileSync(join(item.file, "..", aside[0]), "utf8"), original);
      assert.doesNotMatch(warn.mock.calls.map((c) => c.arguments.join(" ")).join("\n"), /planted-secret/);
      rmSync(item.file, { force: true });
      people.resetPeopleCache();
      assert.doesNotThrow(() => closeStore(item.open()));
    });
  }
});

test("a transcript that cannot be preserved is neither cached empty nor overwritten", (t) => {
  const file = join(data, "messages-lane.json");
  const original = '{"planted-secret":';
  writeFileSync(file, original);
  const saved = new store.Store(() => ({ instanceId: "codex", model: "default" }));
  const real = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: any, to: any) => {
    if (from === file) throw Object.assign(new Error("planted-secret"), { code: "EACCES" });
    return real(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.throws(() => saved.appendMessage("lane", { role: "user", kind: "text", text: "new" }), /EACCES/);
  assert.equal((saved as any).messages.has("lane"), false);
  assert.equal(readFileSync(file, "utf8"), original);
});

test("a failed config read cannot spend a pairing link before registering its device", (t) => {
  const link = pairing.createPairLink();
  const linksFile = join(data, "pair-links.json");
  const original = readFileSync(linksFile, "utf8");
  const file = join(data, "config.json");
  writeFileSync(file, "{}");
  const real = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, "readFileSync", (path: any, ...args: any[]) => {
    // one that does not pass on its own: a passing one is read again
    if (path === file && ++reads === 2) throw Object.assign(new Error("planted-secret"), { code: "EIO" });
    return (real as any)(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.throws(() => pairing.claimPairLink(link.id, "fixture", "a".repeat(64)), /EIO/);
  assert.equal(readFileSync(linksFile, "utf8"), original);
  assert.equal(readFileSync(file, "utf8"), "{}");
});

test("a failed config read leaves a pairing code retryable", (t) => {
  const file = join(data, "config.json");
  writeFileSync(file, "{}");
  const made = pairing.startPairing();
  const restore = refuseRead(t, file, "EMFILE");
  assert.throws(() => pairing.claimPairing(made.code, "fixture"), /EMFILE/);
  assert.equal(pairing.pairingPending(), true);
  restore();
  assert.equal(readFileSync(file, "utf8"), "{}");
  assert.ok(pairing.claimPairing(made.code, "fixture"));
  assert.equal(pairing.claimPairing(made.code, "fixture"), null);
});

test("invite approval and last-room removal read device settings before changing memberships", (t) => {
  const file = join(data, "config.json");
  writeFileSync(file, "{}");
  const { invite } = people.createInvite({ roomId: "room", role: "collaborator", invitedBy: "owner" });
  assert.equal(people.claimInvite(invite.id, { name: "Fixture", token: "a".repeat(43) }).ok, true);
  const peopleFile = join(data, "people.json");
  const original = readFileSync(peopleFile, "utf8");
  const register = (person: import("../server/people.ts").Person) => pairing.addMemberDevice(person.id, person.name, invite.claim!.tokenHash);
  const restore = refuseRead(t, file, "EIO");
  assert.throws(() => people.approveInvite(invite.id, register), /EIO/);
  assert.equal(people.invite(invite.id)!.status, "claimed");
  assert.deepEqual(people.people(), []);
  assert.equal(readFileSync(peopleFile, "utf8"), original);
  restore();
  const approved = people.approveInvite(invite.id, register)!;
  const registered = readFileSync(peopleFile, "utf8");
  const restoreAgain = refuseRead(t, file, "EMFILE");
  assert.throws(() => people.removeFromRoom(approved.person.id, "room", (roomless) => {
    if (roomless) pairing.revokePerson(approved.person.id);
  }), /EMFILE/);
  assert.equal(people.roleIn(approved.person.id, "room"), "collaborator");
  assert.equal(readFileSync(peopleFile, "utf8"), registered);
  restoreAgain();
  assert.equal(people.removeFromRoom(approved.person.id, "room", (roomless) => {
    if (roomless) pairing.revokePerson(approved.person.id);
  }).roomless, true);
  assert.deepEqual(pairing.memberDevices(), []);
});

test("wrong array and config top levels are preserved before empty recovery", async (t) => {
  for (const [file, text, open] of [
    [join(data, "routines.json"), "{}", () => factories.find((f) => f.name === "routines")!.open()],
    [join(data, "config.json"), "[]", () => config.saveConfig({ telegram: { offset: 1 } })],
    [join(data, "config.json"), "null", () => config.loadConfig()],
  ] as const) {
    await t.test(text + " " + file, (t) => {
      writeFileSync(file, text, { mode: 0o600 });
      const before = new Set(readdirSync(data));
      t.mock.method(console, "warn", () => {});
      open();
      const aside = readdirSync(data).filter((f) => !before.has(f) && f.includes(".corrupt-"));
      assert.equal(aside.length, 1);
      assert.equal(readFileSync(join(data, aside[0]), "utf8"), text);
    });
  }
});

test("missing files allow a new agent and its first message", () => {
  const saved = new store.Store(() => ({ instanceId: "codex", model: "default" }));
  assert.deepEqual(saved.bots, []);
  const bot = saved.createBot({ name: "Fixture" });
  assert.deepEqual(saved.messagesFor("fresh"), []);
  saved.appendMessage("fresh", { role: "user", kind: "text", text: "first" });
  assert.equal(saved.messagesFor("fresh").length, 1);
  saved.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hello" });
  assert.equal(saved.messagesFor(bot.threadId).filter((m) => m.text === "hello").length, 1);
  assert.equal(JSON.parse(readFileSync(join(data, "bots.json"), "utf8"))[0].id, bot.id);
});

test("a cold people read can retry without caching an empty membership file", (t) => {
  const file = join(data, "people.json");
  const original = '{"people":[{"id":"person","name":"Fixture"}],"memberships":[],"invites":[],"knocks":[]}';
  writeFileSync(file, original);
  const restore = refuseRead(t, file, "EMFILE");
  assert.throws(() => people.people(), /EMFILE/);
  restore();
  assert.equal(people.people()[0].id, "person");
  assert.equal(readFileSync(file, "utf8"), original);
});
