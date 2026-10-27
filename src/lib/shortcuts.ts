// Every key the app answers to, written down once.
//
// The sheet behind ⌘/ and the hints in the ⌘K palette both read this
// list, so the two can never disagree. It is not where the keys are
// heard: each one still belongs to the component that does the thing
// (the palette hears ⌘K, the sidebar ⌘N, the find bar its Enter). That
// is why this list has to be kept true by hand, and why it was written
// by reading every keydown handler in src/ rather than from memory. A
// new key without a line here is a key nobody finds.
//
// Keys are spelled once, for every platform. "Mod" is ⌘ on a Mac and
// Ctrl everywhere else; "Ctrl" is the Control key on both, which is what
// Ctrl+Tab means on a Mac too, the way browsers have it. The menu bar's
// standard keys (copy, paste, hide, quit, full screen) are the system's
// own and the menu lists them itself, so they are left out here.
//
// What a key does is kept as its catalogue key and put into words where
// the sheet draws it, so the sheet speaks whatever language was chosen
// after this module loaded.
import type { MessageKey } from "./i18n.ts";

export type Platform = "mac" | "other";

/** One combination, modifiers and a key: ["Mod", "K"]. */
export type Chord = readonly string[];

export type ShortcutGroup = "navigation" | "conversation" | "composer" | "terminal" | "app";

export interface Shortcut {
  id: string;
  group: ShortcutGroup;
  /** One chord, or a few that belong together, such as a pair that are
   * each other's opposite (⌥↑ and ⌥↓). */
  keys: readonly Chord[];
  /** A different chord on Mac, when the other platforms keep their own. */
  macKeys?: readonly Chord[];
  /** What it does, as the sheet says it (a catalogue key). */
  does: MessageKey;
  /** Where it means that, when it is not everywhere (a catalogue key). */
  when?: MessageKey;
  /** Heard only by the desktop app. A browser keeps these keys for its
   * own tabs and never passes them to the page. */
  desktopOnly?: boolean;
  /** The Mac menu bar's key, with no twin elsewhere: Windows and Linux
   * close a window with the system's own key. */
  macOnly?: boolean;
}

export const SHORTCUT_GROUPS: ReadonlyArray<{ id: ShortcutGroup; label: MessageKey }> = [
  { id: "navigation", label: "libShortcuts.group.navigation" },
  { id: "conversation", label: "libShortcuts.group.conversation" },
  { id: "composer", label: "libShortcuts.group.composer" },
  { id: "terminal", label: "libShortcuts.group.terminal" },
  { id: "app", label: "libShortcuts.group.app" },
];

export const SHORTCUTS: readonly Shortcut[] = [
  // ── navigation ──
  {
    id: "palette",
    group: "navigation",
    keys: [["Mod", "K"]],
    does: "libShortcuts.does.palette",
  },
  { id: "toggleSidebar", group: "navigation", keys: [["Mod", "B"]], does: "libShortcuts.does.toggleSidebar" },
  { id: "back", group: "navigation", keys: [["Mod", "["]], does: "libShortcuts.does.back" },
  { id: "forward", group: "navigation", keys: [["Mod", "]"]], does: "libShortcuts.does.forward" },
  {
    id: "sidebarStep",
    group: "navigation",
    keys: [["Alt", "Up"], ["Alt", "Down"]],
    does: "libShortcuts.does.sidebarStep",
  },
  {
    id: "sidebarWaiting",
    group: "navigation",
    keys: [["Alt", "Shift", "Up"], ["Alt", "Shift", "Down"]],
    does: "libShortcuts.does.sidebarWaiting",
  },
  {
    id: "recent",
    group: "navigation",
    keys: [["Ctrl", "Tab"], ["Ctrl", "Shift", "Tab"]],
    does: "libShortcuts.does.recent",
    when: "libShortcuts.when.recent",
    desktopOnly: true,
  },
  {
    id: "sidebarAgent",
    group: "navigation",
    keys: [["Mod", "1"], ["Mod", "9"]],
    does: "libShortcuts.does.sidebarAgent",
    when: "libShortcuts.when.sidebarAgent",
    desktopOnly: true,
    macOnly: true,
  },
  {
    id: "workspace",
    group: "navigation",
    keys: [["Mod", "1"], ["Mod", "9"]],
    macKeys: [["Alt", "Mod", "1"], ["Alt", "Mod", "9"]],
    does: "libShortcuts.does.workspace",
    when: "libShortcuts.when.workspace",
    desktopOnly: true,
  },
  {
    id: "moveSection",
    group: "navigation",
    keys: [["Alt", "Up"], ["Alt", "Down"]],
    does: "libShortcuts.does.moveSection",
    when: "libShortcuts.when.moveSection",
  },

  // ── conversation ──
  // The tabs' keys, a browser's (conversationKeys.ts). The menu bar has
  // them too, under File and Window.
  { id: "newConversation", group: "conversation", keys: [["Mod", "T"]], does: "libShortcuts.does.newConversation", desktopOnly: true },
  {
    id: "closeConversation",
    group: "conversation",
    keys: [["Mod", "W"]],
    does: "libShortcuts.does.closeConversation",
    when: "libShortcuts.when.closeConversation",
    desktopOnly: true,
  },
  {
    id: "conversationStep",
    group: "conversation",
    keys: [["Mod", "Shift", "["], ["Mod", "Shift", "]"]],
    does: "libShortcuts.does.conversationStep",
    when: "libShortcuts.when.conversationStep",
    desktopOnly: true,
  },
  {
    id: "tabArrows",
    group: "conversation",
    keys: [["Left"], ["Right"], ["Home"], ["End"]],
    does: "libShortcuts.does.tabArrows",
    when: "libShortcuts.when.tabArrows",
  },
  {
    id: "laneArrows",
    group: "conversation",
    keys: [["Up"], ["Down"], ["Home"], ["End"]],
    does: "libShortcuts.does.laneArrows",
    when: "libShortcuts.when.laneArrows",
  },
  {
    id: "find",
    group: "conversation",
    keys: [["Mod", "F"]],
    does: "libShortcuts.does.find",
  },
  {
    id: "findStep",
    group: "conversation",
    keys: [["Enter"], ["Shift", "Enter"]],
    does: "libShortcuts.does.findStep",
    when: "libShortcuts.when.findStep",
  },
  {
    id: "editLast",
    group: "conversation",
    keys: [["Up"]],
    does: "libShortcuts.does.editLast",
    when: "libShortcuts.when.editLast",
  },

  // ── composer ──
  { id: "send", group: "composer", keys: [["Enter"]], does: "libShortcuts.does.send" },
  { id: "newline", group: "composer", keys: [["Shift", "Enter"]], does: "libShortcuts.does.newline" },
  {
    id: "interrupt",
    group: "composer",
    keys: [["Mod", "Enter"]],
    does: "libShortcuts.does.interrupt",
    when: "libShortcuts.when.interrupt",
  },
  {
    id: "stop",
    group: "composer",
    keys: [["Esc"]],
    does: "libShortcuts.does.stop",
    when: "libShortcuts.when.stop",
  },
  {
    id: "skill",
    group: "composer",
    keys: [["/"]],
    does: "libShortcuts.does.skill",
    when: "libShortcuts.when.skill",
  },
  {
    id: "mention",
    group: "composer",
    keys: [["@"]],
    does: "libShortcuts.does.mention",
    when: "libShortcuts.when.mention",
  },
  {
    id: "stopDictation",
    group: "composer",
    keys: [["Esc"]],
    does: "libShortcuts.does.stopDictation",
    when: "libShortcuts.when.stopDictation",
  },

  // ── terminal ──
  // Matched in terminalTabs.ts, which is also how the shell is told to
  // leave these keys alone.
  { id: "terminalToggle", group: "terminal", keys: [["Ctrl", "`"]], does: "libShortcuts.does.terminalToggle" },
  { id: "terminalNew", group: "terminal", keys: [["Ctrl", "Shift", "`"]], does: "libShortcuts.does.terminalNew" },
  {
    id: "terminalClose",
    group: "terminal",
    keys: [["Ctrl", "Shift", "W"]],
    does: "libShortcuts.does.terminalClose",
    when: "libShortcuts.when.terminalClose",
  },
  {
    id: "terminalStep",
    group: "terminal",
    keys: [["Mod", "Shift", "]"], ["Mod", "Shift", "["]],
    does: "libShortcuts.does.terminalStep",
    when: "libShortcuts.when.terminalStep",
  },
  {
    id: "terminalFill",
    group: "terminal",
    keys: [["Mod", "Shift", "Enter"]],
    does: "libShortcuts.does.terminalFill",
    when: "libShortcuts.when.terminalFill",
  },
  {
    id: "terminalLeave",
    group: "terminal",
    keys: [["Esc"]],
    does: "libShortcuts.does.terminalLeave",
    when: "libShortcuts.when.terminalLeave",
  },

  // ── app ──
  { id: "settings", group: "app", keys: [["Mod", ","]], does: "libShortcuts.does.settings" },
  { id: "newAgent", group: "app", keys: [["Mod", "N"]], does: "libShortcuts.does.newAgent" },
  // ⌘W's old meaning, moved aside for the conversations
  { id: "closeWindow", group: "app", keys: [["Mod", "Shift", "W"]], does: "libShortcuts.does.closeWindow", desktopOnly: true, macOnly: true },
  { id: "shortcuts", group: "app", keys: [["Mod", "/"]], does: "libShortcuts.does.shortcuts" },
  { id: "close", group: "app", keys: [["Esc"]], does: "libShortcuts.does.close" },
  {
    id: "zoom",
    group: "app",
    keys: [["Mod", "+"], ["Mod", "-"], ["Mod", "0"]],
    does: "libShortcuts.does.zoom",
  },
];

/** Which keyboard to draw: a Mac's symbols, or everyone else's words.
 * Read the way deviceWord in thisComputer.ts reads it, and kept here
 * rather than imported so this module loads on its own, which is how
 * the tests run it. The argument is for them: they cannot assign to
 * navigator. */
export function platformOf(said?: string): Platform {
  const read =
    said ?? ((typeof navigator !== "undefined" && (navigator.platform || navigator.userAgent)) || "");
  return /mac|iphone|ipad/i.test(read) ? "mac" : "other";
}

// The names a key goes by. A Mac menu draws modifiers as symbols and
// runs them together (⌥⇧↓); Windows and Linux spell them out and join
// them with a plus (Alt+Shift+↓). Arrows are arrows on both.
const NAMES: Record<Platform, Record<string, string>> = {
  mac: { Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Enter: "↩", Tab: "⇥", Esc: "esc", Up: "↑", Down: "↓", Left: "←", Right: "→" },
  other: {
    Mod: "Ctrl",
    Ctrl: "Ctrl",
    Alt: "Alt",
    Shift: "Shift",
    Enter: "Enter",
    Tab: "Tab",
    Esc: "Esc",
    Up: "↑",
    Down: "↓",
    Left: "←",
    Right: "→",
    "+": "Plus",
  },
};

// Modifiers in each platform's own order: Apple writes ⌃⌥⇧⌘, Windows
// writes Ctrl+Alt+Shift. Written in any order above, they come out right.
const MODIFIERS: Record<Platform, readonly string[]> = {
  mac: ["Ctrl", "Alt", "Shift", "Mod"],
  other: ["Mod", "Ctrl", "Alt", "Shift"],
};

/** One chord as this platform writes it: "⌘K" on a Mac, "Ctrl+K"
 * elsewhere. */
export function chordLabel(chord: Chord, platform: Platform): string {
  const order = MODIFIERS[platform];
  const held = chord
    .filter((key) => order.includes(key))
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const pressed = chord.filter((key) => !order.includes(key));
  const names = [...held, ...pressed].map((key) => NAMES[platform][key] ?? key);
  return platform === "mac" ? names.join("") : names.join("+");
}

/** Whether this app hears a shortcut: a browser tab does not hear the
 * keys the browser keeps, and only a Mac has the menu bar's own. */
function heard(shortcut: Shortcut, desktop: boolean, platform: Platform): boolean {
  return (desktop || !shortcut.desktopOnly) && (platform === "mac" || !shortcut.macOnly);
}

/** Every chord of one shortcut, written for this platform, or nothing
 * for an id the list does not have, or one this app does not hear. */
export function keysFor(id: string, platform: Platform, desktop = true): string[] {
  const shortcut = SHORTCUTS.find((s) => s.id === id);
  return shortcut && heard(shortcut, desktop, platform)
    ? (platform === "mac" ? shortcut.macKeys ?? shortcut.keys : shortcut.keys).map((chord) => chordLabel(chord, platform))
    : [];
}

/** The sheet's contents: each group in order, holding what this app can
 * actually hear. A browser tab drops the keys the browser keeps. */
export function shortcutSheet(
  desktop: boolean,
  platform: Platform = platformOf(),
): Array<{ id: ShortcutGroup; label: MessageKey; shortcuts: Shortcut[] }> {
  return SHORTCUT_GROUPS.map((group) => ({
    ...group,
    shortcuts: SHORTCUTS.filter((s) => s.group === group.id && heard(s, desktop, platform)).map((s) => ({
      ...s,
      keys: platform === "mac" ? s.macKeys ?? s.keys : s.keys,
    })),
  })).filter((group) => group.shortcuts.length > 0);
}
