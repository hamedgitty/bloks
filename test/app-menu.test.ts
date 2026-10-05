// The macOS menu bar (#154): the stock menu, item for item, with
// Settings… and ⌘, added. Replacing the stock menu is where copy and
// paste quietly stop working in every text field, so the roles that
// carry them are checked by name.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { appMenuTemplate, type MenuCommand, type MenuTemplateItem } from "../electron/app-menu.mjs";
import { SHORTCUTS } from "../src/lib/shortcuts.ts";

function build(packaged = true) {
  const asked: MenuCommand[] = [];
  const menu = appMenuTemplate({ name: "Bloks", packaged, command: (word) => asked.push(word) });
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
  // ⌘/ would quietly take the palette or the sheet away. Settings is the
  // one key the menu owns, and the sheet lists it as such.
  for (const packaged of [true, false]) {
    const keyed = all(build(packaged).menu).filter((item) => item.accelerator);
    assert.deepEqual(
      keyed.map((item) => item.label),
      ["Settings…"],
    );
  }
});
