// The type scale, checked where it can quietly break: class merging.
//
// `cn` runs every className through tailwind-merge, which decides which
// of two classes wins. It knows Tailwind's own sizes, not ours, so until
// it is told, `text-body` looks like a colour and evicts the real colour
// beside it. A primary button lost its label that way: white on white.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cn } from "../src/lib/cn.ts";

const SCALE = ["micro", "caption", "small", "body", "ui", "lead", "title", "heading", "display"];

test("a size from the scale never evicts a colour, and the later size wins", () => {
  for (const size of SCALE) {
    assert.equal(cn("bg-primary text-primary-foreground", `text-${size}`), `bg-primary text-primary-foreground text-${size}`);
    assert.equal(cn("text-small text-muted-foreground", `text-${size}`), `text-muted-foreground text-${size}`);
  }
  assert.equal(cn("text-muted-foreground", "text-foreground"), "text-foreground");
});

test("every size cn knows is defined in the stylesheet, and the other way round", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const defined = [...css.matchAll(/^\s*--text-([a-z]+):/gm)].map((m) => m[1]);
  assert.deepEqual(defined, SCALE);
  const merged = readFileSync(new URL("../src/lib/cn.ts", import.meta.url), "utf8");
  for (const size of SCALE) assert.match(merged, new RegExp(`"${size}"`));
});

// Inter has no emoji, so one in an agent's name is drawn by a fallback
// font. Left to the system to pick, some systems picked one that drew
// nothing, and the name started with a blank (GitHub 545). Each stack
// names the color emoji fonts, after its generic family so a character
// the text fonts cover is never drawn as an emoji.
test("every font stack ends on the color emoji fonts, after its generic family", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const EMOJI = ["Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"];
  for (const [name, generic] of [["sans", "sans-serif"], ["mono", "monospace"]] as const) {
    const said = css.match(new RegExp(`--font-${name}:([^;]+);`))?.[1];
    assert.ok(said, `--font-${name} is defined`);
    const families = said.split(",").map((f) => f.trim().replace(/^"|"$/g, ""));
    assert.deepEqual(families.slice(-EMOJI.length), EMOJI, `--font-${name} ends on the emoji fonts`);
    assert.equal(families.indexOf(generic), families.length - EMOJI.length - 1, `--font-${name} names its emoji after ${generic}`);
  }
});
