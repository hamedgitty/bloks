// index.html may not carry an inline script.
//
// The packaged UI is served with a CSP that allows scripts from 'self'
// only, so an inline block is silently refused. The theme check lived
// inline for a while and never ran in a release, which is the flash of
// light theme it existed to prevent. This keeps it in a file.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

test("every script in index.html is loaded from a file", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const tags = html.match(/<script\b[^>]*>/g) ?? [];
  assert.ok(tags.length > 0);
  for (const tag of tags) assert.match(tag, /\ssrc=/, `inline script: ${tag}`);
});

test("the theme script is shipped", () => {
  const js = readFileSync(new URL("../public/theme.js", import.meta.url), "utf8");
  assert.match(js, /bloks-theme/);
});
