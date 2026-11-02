// A skill's supporting files and a new skill as an agent asks for one
// (GitHub 455): names that cannot climb out, plain text within bounds, a
// set replaced whole, and a request read the way the catalogue reads a
// SKILL.md, with its id said exactly.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const data = mkdtempSync(join(tmpdir(), "bloks-skill-files-"));
process.env.BLOKS_DATA_DIR = data;
after(() => rmSync(data, { recursive: true, force: true }));

const files = await import("../server/skill-files.ts");
const { readSkillRequest, fingerprintOf } = await import("../server/skill-requests.ts");

test("a file's name is a plain relative path inside the skill, and never its SKILL.md", () => {
  assert.equal(files.supportingFileName("references/api.md"), "references/api.md");
  assert.equal(files.supportingFileName("./scripts/helper.py"), "scripts/helper.py");
  for (const bad of ["../secrets.txt", "/etc/passwd", "a/../../b", ".env", "refs/.hidden", "a\\b.md", "SKILL.md", "skill.md", "a/b/c/d/e.md", "", " api.md"]) {
    assert.equal(files.supportingFileName(bad), null, bad);
  }
});

test("files are plain text, few, and bounded", () => {
  assert.deepEqual(files.checkSupportingFiles(undefined), { ok: true, files: [] });
  const ok = files.checkSupportingFiles([{ path: "b.md", text: "b" }, { path: "a.md", text: "a" }]);
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.files.map((f) => f.path), ["a.md", "b.md"], "sorted, so the same set reads the same");
  const refuse = (raw: unknown, pattern: RegExp) => {
    const got = files.checkSupportingFiles(raw);
    assert.equal(got.ok, false);
    assert.match(!got.ok ? got.error : "", pattern);
  };
  refuse("nope", /a list/);
  refuse([{ path: "../x", text: "x" }], /not a name/);
  refuse([{ path: "a.md", text: "a" }, { path: "A.md", text: "b" }], /twice/);
  refuse([{ path: "bin.dat", text: "a\u0000b" }], /not text/);
  refuse([{ path: "big.md", text: "x".repeat(files.MAX_SKILL_FILE_BYTES + 1) }], /at most 128 KB/);
  refuse(Array.from({ length: files.MAX_SKILL_FILES + 1 }, (_, i) => ({ path: `f${i}.md`, text: "x" })), /at most 40 files/);
  refuse(Array.from({ length: 7 }, (_, i) => ({ path: `f${i}.md`, text: "x".repeat(120 * 1024) })), /more than 768 KB/);
});

test("a set is written, read, replaced whole and removed; nothing outside is reachable", () => {
  files.writeSupportingFiles("demo", [
    { path: "references/api.md", text: "# API" },
    { path: "scripts/helper.py", text: "print(1)" },
  ]);
  assert.deepEqual(files.listSupportingFiles("demo").map((f) => f.path), ["references/api.md", "scripts/helper.py"]);
  assert.equal(files.readSupportingFile("demo", "references/api.md"), "# API");
  assert.equal(files.readSupportingFile("demo", "../demo/references/api.md"), null);
  // a link planted in the folder that leads out is never followed
  writeFileSync(join(data, "outside.txt"), "secret");
  symlinkSync(join(data, "outside.txt"), join(data, "skill-files", "demo", "leak.md"));
  assert.equal(files.readSupportingFile("demo", "leak.md"), null);
  assert.ok(!files.listSupportingFiles("demo").some((f) => f.path === "leak.md"));
  // replaced as a set: the old files do not linger beside the new
  files.writeSupportingFiles("demo", [{ path: "notes.md", text: "new" }]);
  assert.deepEqual(files.listSupportingFiles("demo").map((f) => f.path), ["notes.md"]);
  assert.ok(files.sameSupportingFiles(files.readSupportingFiles("demo"), [{ path: "notes.md", text: "new" }]));
  assert.ok(!files.sameSupportingFiles(files.readSupportingFiles("demo"), [{ path: "notes.md", text: "old" }]));
  files.writeSupportingFiles("demo", []);
  assert.equal(existsSync(join(data, "skill-files", "demo")), false);
  assert.deepEqual(files.listSupportingFiles("../demo"), []);
  assert.throws(() => files.writeSupportingFiles("../escape", [{ path: "a.md", text: "a" }]));
});

test("a request reads a SKILL.md's name as the id and its title as the name people see", () => {
  const read = readSkillRequest({
    skillMd: "---\nname: stremio-rest\ndescription: The Stremio API\nmetadata:\n  title: Stremio REST\n---\n\nDo the thing.\n",
    files: [{ path: "references/api.md", text: "# API" }],
  });
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.equal(read.draft.id, "stremio-rest");
  assert.equal(read.draft.name, "Stremio REST");
  assert.equal(read.draft.description, "The Stremio API");
  assert.equal(read.draft.body, "Do the thing.");
  assert.equal(read.draft.attach, true);
  assert.equal(read.draft.files.length, 1);
  // flags win over the file, and with no name in the file the id comes
  // from the name people see
  const plain = readSkillRequest({ skillMd: "Just steps.", name: "Morning walk", description: "Plan a walk" });
  assert.ok(plain.ok && plain.draft.id === "morning-walk" && plain.draft.name === "Morning walk");
  const flagged = readSkillRequest({ skillMd: "---\nname: a-b\ndescription: x\n---\nSteps", id: "c-d", attach: false });
  assert.ok(flagged.ok && flagged.draft.id === "c-d" && !flagged.draft.attach);
});

test("a request says exactly what is missing or wrong", () => {
  const refuse = (raw: Record<string, unknown>, status: number, pattern: RegExp) => {
    const got = readSkillRequest(raw);
    assert.equal(got.ok, false);
    if (got.ok) return;
    assert.equal(got.status, status);
    assert.match(got.error, pattern);
  };
  refuse({ name: "X", description: "Y" }, 400, /needs its instructions/);
  refuse({ body: "Steps", description: "Y" }, 400, /needs a name/);
  refuse({ body: "Steps", name: "X" }, 400, /one line on when to use it/);
  refuse({ body: "Steps", name: "X", description: "Y", id: "Not An Id" }, 400, /lowercase letters, numbers and dashes, like not-an-id/);
  refuse({ body: "x".repeat(16_001), name: "X", description: "Y" }, 413, /16,001 characters.*supporting files/);
  refuse({ skillMd: `---\nname: big\ndescription: d\n---\n${"y".repeat(17_000)}` }, 413, /17,000 characters/);
  refuse({ body: "Steps", name: "X", description: "Y", files: [{ path: "../x", text: "x" }] }, 400, /not a name/);
});

test("the same request is the same fingerprint, and any change is another", () => {
  const base = { body: "Steps", name: "X", description: "Y", files: [{ path: "a.md", text: "a" }] };
  const a = readSkillRequest(base);
  const b = readSkillRequest({ ...base, files: [{ path: "a.md", text: "a" }] });
  const c = readSkillRequest({ ...base, files: [{ path: "a.md", text: "b" }] });
  const d = readSkillRequest({ ...base, attach: false });
  assert.ok(a.ok && b.ok && c.ok && d.ok);
  if (!a.ok || !b.ok || !c.ok || !d.ok) return;
  assert.equal(fingerprintOf(a.draft), fingerprintOf(b.draft));
  assert.notEqual(fingerprintOf(a.draft), fingerprintOf(c.draft));
  assert.notEqual(fingerprintOf(a.draft), fingerprintOf(d.draft));
});
