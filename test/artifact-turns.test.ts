// Whose file is it (GitHub 460): two conversations of one agent running at
// once each card only the files that turn made, in either order they
// finish, with a deliberate share, with both editing one file, and a turn
// that ran alone still cards everything it left, as it always did.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const data = mkdtempSync(join(tmpdir(), "bloks-artifact-turns-"));
process.env.BLOKS_DATA_DIR = data;
after(() => rmSync(data, { recursive: true, force: true }));

const artifacts = await import("../server/artifacts.ts");
const { ArtifactTurns } = await import("../server/artifact-turns.ts");

let clock = 1_000_000;
const tick = (ms = 1_000) => (clock += ms);
let agents = 0;
/** A fresh agent with a folder of its own, so no test sees another's files. */
const agent = () => `bot${++agents}`;
/** A file written "now" on the test's clock: the disk's own time would
 * read every write as happening at once. */
function write(botId: string, name: string, body = "made") {
  const path = join(artifacts.artifactsDir(botId), name);
  writeFileSync(path, body);
  utimesSync(path, clock / 1000, clock / 1000);
  return path;
}
const names = (list: Array<{ name: string }>) => list.map((f) => f.name);

test("a turn that ran alone cards everything it left, as before", () => {
  const turns = new ArtifactTurns({ now: () => clock });
  const bot = agent();
  write(bot, "old.html");
  turns.begin("general", bot);
  tick();
  write(bot, "dinners-week-1.html");
  tick();
  assert.deepEqual(names(turns.finish("general")), ["dinners-week-1.html"]);
  // and the next turn, after it, starts from what is there now
  turns.begin("secondary", bot);
  tick();
  assert.deepEqual(turns.finish("secondary"), []);
});

for (const order of ["general first", "secondary first"] as const) {
  test(`overlapping turns: only the one that wrote it cards it (${order})`, () => {
    const turns = new ArtifactTurns({ now: () => clock });
    const bot = agent();
    turns.begin("general", bot);
    turns.begin("secondary", bot);
    tick();
    // General writes the page with a tool that names it
    turns.call("general", { itemId: "w1", paths: [join(artifacts.artifactsDir(bot), "dinners-week-1.html")] });
    write(bot, "dinners-week-1.html");
    turns.callEnded("general", "w1");
    // the other conversation does unrelated work
    turns.call("secondary", { itemId: "c1", command: "curl -s https://example.com/usage" });
    turns.callEnded("secondary", "c1");
    tick();
    const ends = order === "general first" ? ["general", "secondary"] : ["secondary", "general"];
    const got: Record<string, string[]> = {};
    for (const lane of ends) got[lane] = names(turns.finish(lane));
    assert.deepEqual(got.general, ["dinners-week-1.html"]);
    assert.deepEqual(got.secondary, []);
  });
}

test("a file written by a shell command goes to the turn whose command was running", () => {
  const turns = new ArtifactTurns({ now: () => clock });
  const bot = agent();
  turns.begin("general", bot);
  turns.begin("secondary", bot);
  tick();
  turns.call("secondary", { itemId: "s1", mayWrite: true, command: "pytest -q" });
  tick();
  turns.callEnded("secondary", "s1");
  tick(5_000);
  turns.call("general", { itemId: "g1", mayWrite: true, command: "python3 build.py" });
  tick();
  write(bot, "menu.pdf");
  tick();
  turns.callEnded("general", "g1");
  tick();
  assert.deepEqual(names(turns.finish("secondary")), []);
  assert.deepEqual(names(turns.finish("general")), ["menu.pdf"]);
});

test("a turn that says the file's name beats one that only ran a command", () => {
  const turns = new ArtifactTurns({ now: () => clock });
  const bot = agent();
  turns.begin("general", bot);
  turns.begin("secondary", bot);
  tick();
  turns.call("general", { itemId: "g1", mayWrite: true, command: "cat > notes.md <<EOF" });
  turns.call("secondary", { itemId: "s1", mayWrite: true, command: "npm test" });
  write(bot, "notes.md");
  turns.callEnded("general", "g1");
  turns.callEnded("secondary", "s1");
  tick();
  assert.deepEqual(names(turns.finish("general")), ["notes.md"]);
  assert.deepEqual(names(turns.finish("secondary")), []);
});

test("two commands running at once say nothing about whose file it is, so neither cards it", () => {
  const turns = new ArtifactTurns({ now: () => clock });
  const bot = agent();
  turns.begin("general", bot);
  turns.begin("secondary", bot);
  tick();
  turns.call("general", { itemId: "g1", mayWrite: true });
  turns.call("secondary", { itemId: "s1", mayWrite: true });
  write(bot, "mystery.csv");
  turns.callEnded("general", "g1");
  turns.callEnded("secondary", "s1");
  tick();
  assert.deepEqual(turns.finish("general"), []);
  assert.deepEqual(turns.finish("secondary"), []);
  // still the agent's file, to share on purpose
  assert.ok(artifacts.artifactInfo(bot, "mystery.csv"));
});

test("both turns editing one file each card it, in their own conversation", () => {
  const turns = new ArtifactTurns({ now: () => clock });
  const bot = agent();
  const path = write(bot, "plan.md", "v1");
  turns.begin("general", bot);
  turns.begin("secondary", bot);
  tick();
  turns.call("general", { itemId: "g1", paths: [path] });
  write(bot, "plan.md", "v2 from general");
  turns.callEnded("general", "g1");
  tick();
  turns.call("secondary", { itemId: "s1", paths: [path] });
  write(bot, "plan.md", "v3 from the other one");
  turns.callEnded("secondary", "s1");
  tick();
  assert.deepEqual(names(turns.finish("general")), ["plan.md"]);
  assert.deepEqual(names(turns.finish("secondary")), ["plan.md"]);
});

test("a turn that came and went in the middle of a long one still counts", () => {
  const turns = new ArtifactTurns({ now: () => clock });
  const bot = agent();
  turns.begin("long", bot);
  tick();
  turns.begin("quick", bot);
  turns.call("quick", { itemId: "q1", paths: [join(artifacts.artifactsDir(bot), "quick.html")] });
  write(bot, "quick.html");
  turns.callEnded("quick", "q1");
  tick();
  assert.deepEqual(names(turns.finish("quick")), ["quick.html"]);
  tick();
  turns.call("long", { itemId: "l1", paths: [join(artifacts.artifactsDir(bot), "long.html")] });
  write(bot, "long.html");
  turns.callEnded("long", "l1");
  tick();
  assert.deepEqual(names(turns.finish("long")), ["long.html"]);
});

test("a quick turn's file stays its own when its conversation goes on before the long one ends (GitHub 460)", () => {
  const turns = new ArtifactTurns({ now: () => clock });
  const bot = agent();
  turns.begin("L2", bot);
  turns.call("L2", { itemId: "l1", mayWrite: true });
  tick();
  turns.begin("L1", bot);
  turns.call("L1", { itemId: "q1", paths: [join(artifacts.artifactsDir(bot), "quick.html")] });
  write(bot, "quick.html");
  turns.callEnded("L1", "q1");
  tick();
  assert.deepEqual(names(turns.finish("L1")), ["quick.html"]);
  tick();
  // the person says something else in L1 while L2 still runs
  turns.begin("L1", bot);
  tick();
  turns.callEnded("L2", "l1");
  assert.deepEqual(names(turns.finish("L2")), [], "a shell command running when it was written is less than its naming");
  assert.deepEqual(names(turns.finish("L1")), []);
});

test("a file shared on purpose is carded where it was shared and nowhere else", () => {
  const turns = new ArtifactTurns({ now: () => clock });
  const bot = agent();
  turns.begin("general", bot);
  turns.begin("secondary", bot);
  tick();
  // General makes it with a command that names nothing, then shares it
  turns.call("general", { itemId: "g1", mayWrite: true });
  turns.call("secondary", { itemId: "s1", mayWrite: true });
  write(bot, "dinners-week-1.html");
  turns.callEnded("general", "g1");
  turns.callEnded("secondary", "s1");
  turns.shared(bot, "dinners-week-1.html", ["general"]);
  tick();
  assert.deepEqual(turns.finish("secondary"), []);
  assert.deepEqual(turns.finish("general"), [], "already a card, from the share");
});

test("a share from one conversation into another is not carded again by the turn that shared it", () => {
  const turns = new ArtifactTurns({ now: () => clock });
  const bot = agent();
  turns.begin("secondary", bot);
  tick();
  const path = write(bot, "for-general.md");
  turns.call("secondary", { itemId: "s1", paths: [path] });
  turns.callEnded("secondary", "s1");
  turns.shared(bot, "for-general.md", ["general", "secondary"]);
  tick();
  assert.deepEqual(turns.finish("secondary"), []);
});

test("an outbox brought back from elsewhere is that turn's own", () => {
  const turns = new ArtifactTurns({ now: () => clock });
  const bot = agent();
  turns.begin("remote", bot);
  turns.begin("local", bot);
  tick();
  turns.call("local", { itemId: "l1", mayWrite: true });
  write(bot, "from-the-server.txt");
  turns.brought("remote", ["from-the-server.txt"]);
  turns.callEnded("local", "l1");
  tick();
  assert.deepEqual(names(turns.finish("local")), []);
  assert.deepEqual(names(turns.finish("remote")), ["from-the-server.txt"]);
});

test("relative paths are read from where the engine works, and other agents never overlap", () => {
  const turns = new ArtifactTurns({ now: () => clock });
  const bot = agent();
  const stranger = agent();
  turns.begin("theirs", stranger);
  turns.begin("general", bot);
  turns.begin("secondary", bot);
  turns.workingIn("general", artifacts.artifactsDir(bot));
  tick();
  turns.call("general", { itemId: "g1", paths: ["report.html"] });
  turns.call("secondary", { itemId: "s1", paths: ["report.html"] });
  write(bot, "report.html");
  write(stranger, "theirs.txt");
  turns.callEnded("general", "g1");
  turns.callEnded("secondary", "s1");
  tick();
  assert.deepEqual(names(turns.finish("secondary")), [], "a relative path with no folder to read it from names nothing");
  assert.deepEqual(names(turns.finish("general")), ["report.html"]);
  assert.deepEqual(names(turns.finish("theirs")), ["theirs.txt"], "another agent's turn ran alone in its own folder");
});

test("a turn that ended without being finished does not overlap the agent's turns after it", () => {
  const ended = new Set<string>();
  const turns = new ArtifactTurns({ now: () => clock, alive: (id) => !ended.has(id) });
  const bot = agent();
  turns.begin("crashed", bot);
  ended.add("crashed");
  tick();
  turns.begin("general", bot);
  tick();
  turns.call("general", { itemId: "g1", mayWrite: true });
  turns.callEnded("general", "g1");
  tick(5_000);
  // written between calls, which only a turn that ran alone can claim
  write(bot, "after.txt");
  tick();
  assert.deepEqual(names(turns.finish("general")), ["after.txt"], "it ran alone");
  assert.deepEqual(turns.finish("crashed"), [], "and the one that crashed is gone");
});

test("a cancelled turn is forgotten and a finished one is not swept twice", () => {
  const turns = new ArtifactTurns({ now: () => clock });
  const bot = agent();
  turns.begin("never", bot);
  turns.cancel("never");
  assert.equal(turns.has("never"), false);
  turns.begin("general", bot);
  tick();
  write(bot, "once.txt");
  tick();
  assert.deepEqual(names(turns.finish("general")), ["once.txt"]);
  assert.deepEqual(turns.finish("general"), []);
  assert.deepEqual(turns.finish("unknown"), []);
});

test("a file's name said inside a longer name is not the file's name said", async () => {
  const { saysName } = await import("../server/artifact-turns.ts");
  assert.equal(saysName("I wrote notes.md for you", "notes.md"), true);
  assert.equal(saysName("saved to /tmp/out/notes.md.", "notes.md"), true);
  assert.equal(saysName("see `notes.md`", "notes.md"), true);
  assert.equal(saysName("meeting-notes.md is done", "notes.md"), false);
  assert.equal(saysName("old.notes.md", "notes.md"), false);
  assert.equal(saysName("notes.md2", "notes.md"), false);
  assert.equal(saysName("meeting-notes.md and then notes.md", "notes.md"), true);
});
