// Components an API model wrote into its own answer.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { extractComponents } from "../server/components.ts";

const fence = (json: string) => "```bloks\n" + json + "\n```";

describe("extractComponents", () => {
  test("a fenced table becomes a component and leaves the prose", () => {
    const text =
      "Here is how they compare.\n\n" +
      fence('{"kind":"table","columns":["Model","Price"],"rows":[["QC45","$96"]]}') +
      "\n\nPrices expire today.";
    const out = extractComponents(text);
    assert.equal(out.components.length, 1);
    assert.equal(out.components[0].kind, "table");
    assert.equal(out.text, "Here is how they compare.\n\nPrices expire today.");
    assert.equal(out.rejected, 0);
  });

  test("several fences all come through, in order", () => {
    const text =
      fence('{"kind":"quote","text":"one"}') + "\n\nmiddle\n\n" + fence('{"kind":"quote","text":"two"}');
    const out = extractComponents(text);
    assert.deepEqual(
      out.components.map((c) => (c as { text: string }).text),
      ["one", "two"],
    );
    assert.equal(out.text, "middle");
  });

  test("a fence that is not JSON is left visible rather than eaten", () => {
    const text = "before\n\n" + fence("{not json") + "\n\nafter";
    const out = extractComponents(text);
    assert.equal(out.components.length, 0);
    assert.equal(out.rejected, 1);
    assert.ok(out.text.includes("{not json"), "the malformed fence should still be readable");
  });

  test("an unknown kind is refused, not invented", () => {
    const out = extractComponents(fence('{"kind":"hologram","x":1}'));
    assert.equal(out.components.length, 0);
    assert.equal(out.rejected, 1);
  });

  test("a known kind with a bad shape is refused", () => {
    const out = extractComponents(fence('{"kind":"table","columns":"nope"}'));
    assert.equal(out.components.length, 0);
    assert.equal(out.rejected, 1);
  });

  test("an ordinary code fence is untouched", () => {
    const text = "```json\n{\"kind\":\"table\"}\n```";
    const out = extractComponents(text);
    assert.equal(out.components.length, 0);
    assert.equal(out.text, text);
  });

  test("text with no fence comes back unchanged", () => {
    const out = extractComponents("just a sentence");
    assert.deepEqual(out, { components: [], text: "just a sentence", rejected: 0 });
  });

  test("a fence indented inside a list still parses", () => {
    const out = extractComponents("  ```bloks\n" + '{"kind":"quote","text":"hi"}' + "\n  ```");
    assert.equal(out.components.length, 1);
  });
});
