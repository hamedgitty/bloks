import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { agentNumberKey, workspaceNumberKey } from "../src/lib/numberKeys.ts";

const key = (over: Partial<KeyboardEvent> = {}) => ({
  key: "1",
  code: "Digit1",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
  defaultPrevented: false,
  ...over,
});

describe("numbered navigation keys", () => {
  test("Mac agent and workspace chords are distinct, including Option-produced symbols", () => {
    assert.equal(agentNumberKey(key({ metaKey: true })), 1);
    assert.equal(agentNumberKey(key({ metaKey: true, key: "9", code: "Digit9" })), 9);
    const option = key({ metaKey: true, altKey: true, key: "¡", code: "Digit1" });
    assert.equal(workspaceNumberKey(option, "mac"), 1);
    assert.equal(agentNumberKey(option), null);
    assert.equal(workspaceNumberKey(key({ metaKey: true }), "mac"), null);
    assert.equal(workspaceNumberKey(key({ metaKey: true, altKey: true, code: "", key: "2" }), "mac"), 2);
  });

  test("a Mac number code takes precedence, including Option glyphs and the numpad", () => {
    for (const [glyph, code, number] of [["¡", "Digit1", 1], ["ª", "Digit9", 9], ["1", "Numpad1", 1], ["9", "Numpad9", 9]] as const) {
      assert.equal(workspaceNumberKey(key({ metaKey: true, altKey: true, key: glyph, code }), "mac"), number);
    }
    assert.equal(agentNumberKey(key({ metaKey: true, key: "9", code: "Digit1" })), 1);
    assert.equal(workspaceNumberKey(key({ metaKey: true, altKey: true, key: "1", code: "Digit9" }), "mac"), 9);
    assert.equal(agentNumberKey(key({ metaKey: true, key: "9", code: "" })), 9);
    for (const code of ["Digit0", "Numpad0", "KeyX", "Digit10", "Unidentified"]) {
      assert.equal(agentNumberKey(key({ metaKey: true, key: "1", code })), null, code);
      assert.equal(workspaceNumberKey(key({ metaKey: true, altKey: true, key: "1", code }), "mac"), null, code);
    }
  });

  test("extra modifiers, composition, repeat and consumed events do not navigate on Mac", () => {
    for (const extra of [{ ctrlKey: true }, { shiftKey: true }, { repeat: true }, { isComposing: true }, { defaultPrevented: true }]) {
      assert.equal(agentNumberKey(key({ metaKey: true, ...extra })), null);
      assert.equal(workspaceNumberKey(key({ metaKey: true, altKey: true, ...extra }), "mac"), null);
    }
    for (const bad of [{ key: "0", code: "Digit0" }, { key: "x", code: "KeyX" }]) {
      assert.equal(agentNumberKey(key({ metaKey: true, ...bad })), null);
      assert.equal(workspaceNumberKey(key({ metaKey: true, altKey: true, ...bad }), "mac"), null);
    }
  });

  test("other platforms keep their existing Ctrl+number workspace key", () => {
    assert.equal(workspaceNumberKey(key({ ctrlKey: true }), "other"), 1);
    assert.equal(workspaceNumberKey(key({ ctrlKey: true, repeat: true }), "other"), 1);
    assert.equal(workspaceNumberKey(key({ ctrlKey: true, isComposing: true, code: "KeyX", key: "9" }), "other"), 9);
    assert.equal(workspaceNumberKey(key({ ctrlKey: true, altKey: true }), "other"), null);
    assert.equal(workspaceNumberKey(key({ metaKey: true }), "other"), null);
  });
});
