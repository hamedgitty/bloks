// The voice reads prose, not markup.
import { test } from "node:test";
import assert from "node:assert/strict";

import { speakable } from "../server/speech-text.ts";

test("markdown flattens into something sayable", () => {
  const spoken = speakable(
    "## Results\n\n- **Revenue** rose `12%`\n- See [the report](https://x.com/r)\n\n```ts\nconst x = 1;\n```\n",
  );
  assert.match(spoken, /Results\./);
  assert.match(spoken, /Revenue rose 12%/);
  assert.match(spoken, /the report/);
  assert.match(spoken, /TypeScript code block/);
  assert.ok(!spoken.includes("**"), "emphasis marks leaked");
  assert.ok(!spoken.includes("https://"), "a URL leaked");
});

test("emoji vanish and empty input stays silent", () => {
  assert.equal(speakable("Done ✅🎉"), "Done");
  assert.equal(speakable("  \n\n  "), "");
  assert.equal(speakable("***"), "");
});
