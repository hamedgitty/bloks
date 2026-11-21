// The search in the Archived agents dialog (GitHub 538): part of a name
// or a role, in any case, live, and a blank query is the whole list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { archivedMatching } from "../src/lib/archivedSearch.ts";

const archived = [
  { id: "a", name: "Ada", title: "Research lead" },
  { id: "b", name: "Grace Hopper", title: "Compiler writer" },
  { id: "c", name: "Linus", title: undefined },
  { id: "d", name: "Margaret", title: "Flight software" },
];
const ids = (query: string) => archivedMatching(archived, query).map((b) => b.id);

test("part of a name or of a role finds the agent, in any case", () => {
  assert.deepEqual(ids("ada"), ["a"]);
  assert.deepEqual(ids("HOP"), ["b"]);
  assert.deepEqual(ids("research"), ["a"]);
  assert.deepEqual(ids("Writer"), ["b"]);
  assert.deepEqual(ids("ar"), ["a", "d"]);
  // an agent with no role is still found by its name
  assert.deepEqual(ids("lin"), ["c"]);
});

test("every word has to be found, in the name or the role", () => {
  assert.deepEqual(ids("grace compiler"), ["b"]);
  assert.deepEqual(ids("  margaret   flight "), ["d"]);
  assert.deepEqual(ids("grace flight"), []);
});

test("a blank query is the whole list in its own order, and nothing found is an empty list", () => {
  assert.deepEqual(ids(""), ["a", "b", "c", "d"]);
  assert.deepEqual(ids("   "), ["a", "b", "c", "d"]);
  assert.deepEqual(ids("nobody"), []);
  // a copy, so the dialog never reorders the store's own list
  assert.notEqual(archivedMatching(archived, ""), archived);
});

test("the dialog filters with it, says when nothing matches, and keeps Restore and the delete confirmation", () => {
  const source = readFileSync(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8");
  const dialog = source.slice(source.indexOf("function ArchivedAgents"));
  assert.match(dialog, /const found = archivedMatching\(archived, query\)/);
  assert.match(dialog, /found\.map\(\(bot\)/);
  assert.match(dialog, /t\("sidebar\.noArchivedMatch"/);
  assert.match(dialog, /t\("sidebar\.clearArchivedSearch"\)/);
  assert.match(dialog, /type: "restoreBot"/);
  assert.match(dialog, /confirm\(\{[\s\S]*?destructive: true,[\s\S]*?type: "deleteBot"/);
  for (const lang of ["en", "es", "fr", "de", "pt-BR", "ja", "zh-CN"]) {
    const words = JSON.parse(readFileSync(new URL(`../src/locales/${lang}.json`, import.meta.url), "utf8"));
    for (const key of ["sidebar.searchArchived", "sidebar.clearArchivedSearch", "sidebar.noArchivedMatch"]) assert.equal(typeof words[key], "string", `${lang} ${key}`);
  }
});
