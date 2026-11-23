// The emoji faces at the end of the sans stack (GitHub 545).
//
// Our stack replaces Tailwind's, and Tailwind's ends on these faces. A Mac
// finds an emoji face without them, so losing them again in a later edit
// would go unseen on the machine the app is built and checked on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const EMOJI = ["Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"];

test("the sans stack ends on the emoji faces, after every text face", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const stack = css.match(/^\s*--font-sans:([^;]+);/m)?.[1];
  assert.ok(stack, "--font-sans is not defined in styles.css");
  const faces = stack.split(",").map((face) => face.trim().replace(/^["']|["']$/g, ""));
  assert.deepEqual(faces.slice(-EMOJI.length), EMOJI);
  assert.ok(faces.includes("sans-serif"), "no generic text face ahead of the emoji faces");
});
