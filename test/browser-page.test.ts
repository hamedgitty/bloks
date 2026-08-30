// The page half of browser control: what an agent is shown, and what
// the scripts we inject actually say.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { clickScript, focusScript, formatSnapshot, READ, SCAN } from "../server/page-script.ts";

describe("formatSnapshot", () => {
  const scan = (nodes: any[]) => formatSnapshot({ url: "https://x.test/", title: "Shop", nodes });

  test("one line per control, with its ref", () => {
    const out = scan([
      { ref: "e1", role: "button", name: "Buy now" },
      { ref: "e2", role: "link", name: "Learn more" },
    ]);
    assert.match(out, /^Shop — https:\/\/x\.test\//m);
    assert.match(out, /2 controls:/);
    assert.match(out, /@e1 button "Buy now"/);
    assert.match(out, /@e2 link "Learn more"/);
  });

  test("field values, checked state and disabled are shown", () => {
    const out = scan([
      { ref: "e1", role: "textbox", name: "Email", value: "me@x.test" },
      { ref: "e2", role: "checkbox", name: "Remember me", checked: false },
      { ref: "e3", role: "button", name: "Submit", disabled: true },
    ]);
    assert.match(out, /@e1 textbox "Email" value="me@x\.test"/);
    assert.match(out, /@e2 checkbox "Remember me" unchecked/);
    assert.match(out, /@e3 button "Submit" disabled/);
  });

  test("an unnamed control is kept, because it may be the one needed", () => {
    const out = scan([{ ref: "e1", role: "button", name: "" }]);
    assert.match(out, /@e1 button/);
  });

  test("an empty page says so rather than showing an empty list", () => {
    assert.match(scan([]), /no controls found/);
  });

  test("a name with quotes in it stays parseable", () => {
    const out = scan([{ ref: "e1", role: "button", name: 'Say "hi"' }]);
    assert.match(out, /@e1 button "Say \\"hi\\""/);
  });
});

describe("injected scripts", () => {
  test("a ref reaches the page as data, not as source", () => {
    const script = clickScript('e1"] , [x');
    // The ref is JSON, so a quote in it cannot close our selector.
    assert.ok(script.includes(JSON.stringify('e1"] , [x')));
    assert.ok(!script.includes(`[data-bloks-ref="e1"] , [x"]`));
  });

  test("click scrolls, measures, and asks what is really at the point", () => {
    const script = clickScript("e1");
    assert.match(script, /scrollIntoView/);
    assert.match(script, /elementFromPoint/);
    assert.match(script, /covered/);
  });

  test("focus clears the field only when asked", () => {
    assert.match(focusScript("e1", true), /el\.value = ""/);
    assert.ok(!focusScript("e1", false).includes('el.value = ""'));
  });

  test("the scan bounds how much it returns", () => {
    assert.match(SCAN, /n >= 250/);
    assert.match(SCAN, /data-bloks-ref/);
  });

  test("read strips the furniture and caps its length", () => {
    assert.match(READ, /script,style,noscript/);
    assert.match(READ, /slice\(0, 24000\)/);
  });

  test("every script is a single expression, as Runtime.evaluate needs", () => {
    for (const script of [SCAN, READ, clickScript("e1"), focusScript("e1", true)]) {
      assert.match(script.trim(), /^\(\(\) => \{/, "should be an IIFE");
      assert.match(script.trim(), /\}\)\(\)$/);
    }
  });
});
