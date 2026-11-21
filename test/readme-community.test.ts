// The Discord invite is where a would-be contributor looks first: the top
// of the README and its Contributing section (GitHub 531), and always the
// same invite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const INVITE = "https://discord.gg/FhV3SuGYfS";

test("the README opens with the Discord invite, before its first section", () => {
  const opening = README.slice(0, README.indexOf("\n## "));
  assert.ok(opening.includes(INVITE));
});

test("the Contributing section starts with the Discord invite", () => {
  const start = README.indexOf("\n## Contributing\n");
  assert.ok(start >= 0);
  const end = README.indexOf("\n## ", start + 1);
  const section = README.slice(start + 1, end < 0 ? undefined : end);
  const firstParagraph = section.split("\n\n")[1] ?? "";
  assert.ok(firstParagraph.includes(INVITE), firstParagraph);
});

test("every Discord link in the README is the one invite", () => {
  const links = README.match(/https:\/\/discord\.gg\/\w+/g) ?? [];
  assert.ok(links.length >= 2);
  assert.deepEqual([...new Set(links)], [INVITE]);
});
