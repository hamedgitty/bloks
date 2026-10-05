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

export type Platform = "mac" | "other";

/** One combination, modifiers and a key: ["Mod", "K"]. */
export type Chord = readonly string[];

export type ShortcutGroup = "navigation" | "conversation" | "composer" | "app";

export interface Shortcut {
  id: string;
  group: ShortcutGroup;
  /** One chord, or a few that belong together, such as a pair that are
   * each other's opposite (⌥↑ and ⌥↓). */
  keys: readonly Chord[];
  /** What it does, as the sheet says it. */
  does: string;
  /** Where it means that, when it is not everywhere. */
  when?: string;
  /** Heard only by the desktop app. A browser keeps these keys for its
   * own tabs and never passes them to the page. */
  desktopOnly?: boolean;
}

export const SHORTCUT_GROUPS: ReadonlyArray<{ id: ShortcutGroup; label: string }> = [
  { id: "navigation", label: "Navigation" },
  { id: "conversation", label: "Conversation" },
  { id: "composer", label: "Composer" },
  { id: "app", label: "App" },
];

export const SHORTCUTS: readonly Shortcut[] = [
  // ── navigation ──
  {
    id: "palette",
    group: "navigation",
    keys: [["Mod", "K"]],
    does: "Jump to an agent, a room, a setting or a message",
  },
  {
    id: "sidebarStep",
    group: "navigation",
    keys: [["Alt", "Up"], ["Alt", "Down"]],
    does: "Previous or next agent or room",
  },
  {
    id: "sidebarWaiting",
    group: "navigation",
    keys: [["Alt", "Shift", "Up"], ["Alt", "Shift", "Down"]],
    does: "Previous or next one that is unread or waiting on you",
  },
  {
    id: "recent",
    group: "navigation",
    keys: [["Ctrl", "Tab"], ["Ctrl", "Shift", "Tab"]],
    does: "Back to the conversation you were just in",
    when: "hold Ctrl and keep pressing Tab to go further back",
    desktopOnly: true,
  },
  {
    id: "moveSection",
    group: "navigation",
    keys: [["Alt", "Up"], ["Alt", "Down"]],
    does: "Move a section up or down",
    when: "on a focused section heading",
  },

  // ── conversation ──
  {
    id: "find",
    group: "conversation",
    keys: [["Mod", "F"]],
    does: "Find in this conversation",
  },
  {
    id: "findStep",
    group: "conversation",
    keys: [["Enter"], ["Shift", "Enter"]],
    does: "Next or previous match",
    when: "while finding",
  },
  {
    id: "editLast",
    group: "conversation",
    keys: [["Up"]],
    does: "Edit your last message",
    when: "in an empty composer, with an agent",
  },

  // ── composer ──
  { id: "send", group: "composer", keys: [["Enter"]], does: "Send" },
  { id: "newline", group: "composer", keys: [["Shift", "Enter"]], does: "New line" },
  {
    id: "interrupt",
    group: "composer",
    keys: [["Mod", "Enter"]],
    does: "Stop the agent and send now",
    when: "while it is working",
  },
  {
    id: "skill",
    group: "composer",
    keys: [["/"]],
    does: "Use one of the agent's skills",
    when: "at the start of a word",
  },
  {
    id: "mention",
    group: "composer",
    keys: [["@"]],
    does: "Mention someone",
    when: "in a room",
  },
  {
    id: "stopDictation",
    group: "composer",
    keys: [["Esc"]],
    does: "Stop dictation",
    when: "while dictating",
  },

  // ── app ──
  { id: "settings", group: "app", keys: [["Mod", ","]], does: "Settings" },
  { id: "newAgent", group: "app", keys: [["Mod", "N"]], does: "New agent" },
  { id: "shortcuts", group: "app", keys: [["Mod", "/"]], does: "Keyboard shortcuts" },
  { id: "close", group: "app", keys: [["Esc"]], does: "Close what is on top" },
  {
    id: "zoom",
    group: "app",
    keys: [["Mod", "+"], ["Mod", "-"], ["Mod", "0"]],
    does: "Zoom in, zoom out, actual size",
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
  mac: { Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Enter: "↩", Tab: "⇥", Esc: "esc", Up: "↑", Down: "↓" },
  other: { Mod: "Ctrl", Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Enter: "Enter", Tab: "Tab", Esc: "Esc", Up: "↑", Down: "↓", "+": "Plus" },
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

/** Every chord of one shortcut, written for this platform, or nothing
 * for an id the list does not have. */
export function keysFor(id: string, platform: Platform): string[] {
  const shortcut = SHORTCUTS.find((s) => s.id === id);
  return shortcut ? shortcut.keys.map((chord) => chordLabel(chord, platform)) : [];
}

/** The sheet's contents: each group in order, holding what this app can
 * actually hear. A browser tab drops the keys the browser keeps. */
export function shortcutSheet(desktop: boolean): Array<{ id: ShortcutGroup; label: string; shortcuts: Shortcut[] }> {
  return SHORTCUT_GROUPS.map((group) => ({
    ...group,
    shortcuts: SHORTCUTS.filter((s) => s.group === group.id && (desktop || !s.desktopOnly)),
  })).filter((group) => group.shortcuts.length > 0);
}
