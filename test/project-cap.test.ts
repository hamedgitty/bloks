// The most projects Bloks keeps: room for a new one is made from the
// archived, never by dropping one still in use.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

// the store writes where the data folder is, so it is a throwaway one
const home = mkdtempSync(join(tmpdir(), "bloks-project-cap-"));
let projects: typeof import("../server/projects.ts");

before(async () => {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const config = await import("../server/config.ts");
  assert.equal(config.DATA_DIR, join(home, ".bloks"));
  projects = await import("../server/projects.ts");
});
after(() => rmSync(home, { recursive: true, force: true }));

test("a project past the limit takes the place of the one archived longest ago, or is refused", () => {
  const { MAX_PROJECTS, ProjectStore } = projects;
  const store = new ProjectStore();
  const first = store.create({ name: "The first, still in use" }, 1)!;
  for (let at = 2; at <= MAX_PROJECTS; at++) store.create({ name: `Project ${at}` }, at);

  const refused = store.create({ name: "One too many" }, 100);
  assert.equal(refused, null, "with nothing archived there is no room");
  assert.ok(store.get(first.id), "the oldest project, still in use, is kept");
  assert.equal(store.list(true).length, MAX_PROJECTS);

  // two finished with, the later of them archived first
  const done = store.list(true).filter((p) => p.id !== first.id);
  store.archive(done[1].id, 200);
  store.archive(done[0].id, 300);
  const made = store.create({ name: "Now there is room" }, 400);
  assert.ok(made);
  assert.equal(store.get(done[1].id), null, "the one archived longest ago made room");
  assert.ok(store.get(done[0].id), "the other archived one stays");
  assert.ok(store.get(first.id));
  assert.equal(store.list(true).length, MAX_PROJECTS);
});
