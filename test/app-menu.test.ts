// The macOS menu bar (#154): the stock menu, item for item, with
// Settings… and ⌘, added. Replacing the stock menu is where copy and
// paste quietly stop working in every text field, so the roles that
// carry them are checked by name.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { appMenuTemplate, TAB_COMMANDS, type MenuCommand, type MenuTemplateItem } from "../electron/app-menu.mjs";
import { fileURLToPath } from "node:url";
import { menuWords } from "../electron/menu-words.mjs";
import { SHORTCUTS } from "../src/lib/shortcuts.ts";

const words = menuWords(fileURLToPath(new URL("../src/locales", import.meta.url)), "en");

function build(packaged = true) {
  const asked: MenuCommand[] = [];
  const menu = appMenuTemplate({ name: "Bloks", packaged, command: (word) => asked.push(word), words });
  return { menu, asked };
}

const roles = (items: MenuTemplateItem[] = []) => items.map((item) => item.role).filter(Boolean);

const all = (items: MenuTemplateItem[]): MenuTemplateItem[] =>
  items.flatMap((item) => [item, ...all(item.submenu ?? [])]);

describe("the app menu", () => {
  test("keeps every stock item, with Settings… after About as Apple places it", () => {
    const [app] = build().menu;
    const items = app.submenu ?? [];
    assert.deepEqual(roles(items), ["about", "services", "hide", "hideOthers", "unhide", "quit"]);
    const settings = items.findIndex((item) => item.label === "Settings…");
    assert.equal(settings, 2, "About, a separator, then Settings…");
    assert.equal(items[settings].accelerator, "CmdOrCtrl+,");
  });

  test("Settings… asks the window to open Settings", () => {
    const { menu, asked } = build();
    menu[0].submenu?.find((item) => item.label === "Settings…")?.click?.();
    assert.deepEqual(asked, ["settings"]);
  });

  test("its key is the one the shortcuts sheet lists for Settings", () => {
    const listed = SHORTCUTS.find((s) => s.id === "settings")?.keys.map((chord) => chord.join("+"));
    assert.deepEqual(listed, ["Mod+,"]);
    const [app] = build().menu;
    const key = app.submenu?.find((item) => item.label === "Settings…")?.accelerator;
    assert.equal(key?.replace("CmdOrCtrl", "Mod"), "Mod+,");
  });
});

describe("the rest of the bar", () => {
  test("Edit carries every editing role, so copy and paste work in every field", () => {
    const edit = build().menu.find((m) => m.label === "Edit");
    for (const role of ["undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "delete", "selectAll"]) {
      assert.ok(roles(edit?.submenu).includes(role), `Edit is missing ${role}`);
    }
  });

  test("File closes the window, and the Window menu lists and arranges windows", () => {
    const { menu } = build();
    assert.deepEqual(roles(menu.find((m) => m.label === "File")?.submenu), ["close"]);
    const window = menu.find((m) => m.role === "window");
    assert.deepEqual(roles(window?.submenu), ["minimize", "zoom", "front"]);
  });

  // GitHub 401: ⌘W closed the whole window, where a tab strip means the tab.
  const file = () => build().menu.find((m) => m.label === "File")?.submenu ?? [];
  const windowMenu = () => build().menu.find((m) => m.role === "window")?.submenu ?? [];

  test("File has New and Close Conversation on ⌘T and ⌘W, and Close Window moved to ⌘⇧W", () => {
    const items = file();
    assert.deepEqual(
      items.filter((item) => item.type !== "separator").map((item) => [item.label ?? item.role, item.accelerator]),
      [
        ["New Conversation", "CmdOrCtrl+T"],
        ["Close Conversation", "CmdOrCtrl+W"],
        ["Close Window", "CmdOrCtrl+Shift+W"],
      ],
    );
  });

  test("Window steps through them on ⌘⇧[ and ⌘⇧], and still arranges windows", () => {
    const keyed = windowMenu().filter((item) => item.accelerator);
    assert.deepEqual(
      keyed.map((item) => [item.label, item.accelerator]),
      [
        ["Previous Conversation", "CmdOrCtrl+Shift+["],
        ["Next Conversation", "CmdOrCtrl+Shift+]"],
      ],
    );
  });

  test("each asks the window with its own word, and those are the words the main process sends on", () => {
    const { menu, asked } = build();
    for (const label of ["New Conversation", "Close Conversation", "Previous Conversation", "Next Conversation"]) {
      all(menu).find((item) => item.label === label)?.click?.();
    }
    assert.deepEqual(asked, ["newConversation", "closeConversation", "previousConversation", "nextConversation"]);
    assert.deepEqual([...TAB_COMMANDS].sort(), [...asked].sort());
  });

  test("the window's own Close stays a role, so macOS still closes whichever window is in front", () => {
    const close = file().find((item) => item.role === "close");
    assert.equal(close?.click, undefined);
  });

  test("their keys are the ones the shortcuts sheet lists", () => {
    const listed = (id: string) =>
      SHORTCUTS.find((s) => s.id === id)?.keys.map((chord) => chord.join("+").replace("Mod", "CmdOrCtrl"));
    const keyOf = (label: string) => all(build().menu).find((item) => item.label === label)?.accelerator;
    assert.deepEqual(listed("newConversation"), [keyOf("New Conversation")]);
    assert.deepEqual(listed("closeConversation"), [keyOf("Close Conversation")]);
    assert.deepEqual(listed("conversationStep"), [keyOf("Previous Conversation"), keyOf("Next Conversation")]);
    assert.deepEqual(listed("closeWindow"), [file().find((item) => item.role === "close")?.accelerator]);
  });

  test("View keeps zoom and full screen in every build", () => {
    for (const packaged of [true, false]) {
      const view = build(packaged).menu.find((m) => m.label === "View");
      for (const role of ["resetZoom", "zoomIn", "zoomOut", "togglefullscreen"]) {
        assert.ok(roles(view?.submenu).includes(role), `View is missing ${role}`);
      }
    }
  });

  test("Reload and the developer tools only in a build run from source", () => {
    const view = (packaged: boolean) => roles(build(packaged).menu.find((m) => m.label === "View")?.submenu);
    for (const role of ["reload", "forceReload", "toggleDevTools"]) {
      assert.ok(view(false).includes(role), `a build from source is missing ${role}`);
      assert.ok(!view(true).includes(role), `an installed app offers ${role}`);
    }
  });

  test("Help opens the shortcuts sheet", () => {
    const { menu, asked } = build();
    const help = menu.find((m) => m.role === "help");
    help?.submenu?.find((item) => item.label === "Keyboard Shortcuts")?.click?.();
    assert.deepEqual(asked, ["shortcuts"]);
  });
});

test("no menu key takes one the window answers to", () => {
  // A key equivalent is heard before the page, so a menu item on ⌘K or
  // ⌘/ would quietly take the palette or the sheet away. Settings is one
  // key the menu owns; the conversation tabs' are the others, and those
  // are played back to the page as keys, so the page still decides.
  for (const packaged of [true, false]) {
    const keyed = all(build(packaged).menu).filter((item) => item.accelerator);
    assert.deepEqual(
      keyed.map((item) => item.label ?? item.role),
      ["Settings…", "New Conversation", "Close Conversation", "Close Window", "Previous Conversation", "Next Conversation"],
    );
    // and none of them is one the page keeps to itself
    const owned = keyed.map((item) => item.accelerator?.replace("CmdOrCtrl", "Mod"));
    for (const id of ["palette", "newAgent", "find", "shortcuts", "interrupt", "back", "forward", "recent", "workspace", "sidebarAgent", "toggleSidebar"]) {
      const shortcut = SHORTCUTS.find((s) => s.id === id);
      for (const chord of [...(shortcut?.keys ?? []), ...(shortcut?.macKeys ?? [])]) {
        assert.ok(!owned.includes(chord.join("+")), `the menu took ${id}'s ${chord.join("+")}`);
      }
    }
  }
});
