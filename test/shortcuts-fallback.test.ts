import assert from "node:assert/strict";
import { test } from "node:test";
import { addCatalogue, getLanguage, setLanguage, t } from "../src/lib/i18n.ts";
import { chordLabel, keysFor, shortcutSheet } from "../src/lib/shortcuts.ts";
import { agentNumberKey, workspaceNumberKey } from "../src/lib/numberKeys.ts";

test("a missing numbered-agent translation falls back without changing its keys", async () => {
  const before = getLanguage();
  const agent = shortcutSheet(true, "mac").flatMap((group) => group.shortcuts).find((shortcut) => shortcut.id === "sidebarAgent")!;
  assert.equal(agent.id, "sidebarAgent");
  assert.equal(agent.does, "libShortcuts.does.sidebarAgent");
  assert.ok(agent.when);
  assert.equal(agent.when, "libShortcuts.when.sidebarAgent");
  try {
    // This process has not loaded German yet. A partial catalogue models
    // a language that has the context line but lacks this action label.
    addCatalogue("de", { [agent.when]: "Nur der Kontext ist übersetzt" });
    await setLanguage("de");
    assert.equal(t(agent.does), "Go to an agent in the sidebar");
    assert.equal(t(agent.when!), "Nur der Kontext ist übersetzt");
    assert.doesNotMatch(t(agent.does), /\{[^}]+\}/);
    const plain = { key: "2", code: "Digit2", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, defaultPrevented: false };
    assert.equal(agentNumberKey(plain), 2);
    assert.equal(workspaceNumberKey({ ...plain, key: "™", altKey: true }, "mac"), 2);
    assert.deepEqual(agent.keys.map((chord) => chordLabel(chord, "mac")), ["⌘1", "⌘9"]);
    assert.deepEqual(keysFor("workspace", "mac"), ["⌥⌘1", "⌥⌘9"]);
    assert.deepEqual(keysFor("workspace", "other"), ["Ctrl+1", "Ctrl+9"]);
  } finally {
    await setLanguage(before);
  }
});
