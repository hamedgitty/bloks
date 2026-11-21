// Where a plain click on a link in a chat goes (GitHub 539): the Bloks
// browser in the dock only where it can open a page and the person has
// not chosen their own browser; everywhere else, the person's browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { browserWhere, noteServerBrowser, type BrowserWhere } from "../src/lib/appBrowser.ts";
import { linksOpenInDock, readChatLinksIn } from "../src/lib/chatLinks.ts";
import { SETTINGS_PAGE_INDEX } from "../server/settings-index.ts";

const own: BrowserWhere = { home: "own", missing: null, available: true };
const server: BrowserWhere = { home: "server", missing: null, available: true };

test("by default a link opens in the dock where its browser can open a page", () => {
  assert.equal(linksOpenInDock(own, "bloks"), true);
  assert.equal(linksOpenInDock(server, "bloks"), true);
});

test("a server whose browser cannot open a page sends links to the person's own browser", () => {
  for (const missing of ["none", "off", "path"] as const) {
    assert.equal(linksOpenInDock({ home: "server", missing, available: false }, "bloks"), false, missing);
  }
  // unavailable without a reason given is still unavailable
  assert.equal(linksOpenInDock({ home: "server", missing: null, available: false }, "bloks"), false);
  // and with no browser here at all, or none known yet, nothing changes
  assert.equal(linksOpenInDock({ home: "elsewhere", missing: null, available: false }, "bloks"), false);
  assert.equal(linksOpenInDock({ home: null, missing: null, available: false }, "bloks"), false);
});

test("choosing my browser keeps every link out of the dock, even with a working browser", () => {
  assert.equal(linksOpenInDock(own, "own"), false);
  assert.equal(linksOpenInDock(server, "own"), false);
});

test("what the server says of its browser decides it, missing and available alike", () => {
  noteServerBrowser({ where: "server", available: false, missing: "none", state: null });
  assert.deepEqual(browserWhere(), { home: "server", missing: "none", available: false });
  assert.equal(linksOpenInDock(browserWhere(), "bloks"), false);
  noteServerBrowser({ where: "server", available: false, state: null });
  assert.equal(linksOpenInDock(browserWhere(), "bloks"), false);
  noteServerBrowser({ where: "server", available: true, state: null });
  assert.equal(linksOpenInDock(browserWhere(), "bloks"), true);
});

test("the choice is read from this device, and anything odd there is the default", () => {
  const storing = (value: string | null) => ({ getItem: (key: string) => (key === "bloks-chat-links" ? value : null) });
  assert.equal(readChatLinksIn(storing("own")), "own");
  assert.equal(readChatLinksIn(storing("bloks")), "bloks");
  assert.equal(readChatLinksIn(storing(null)), "bloks");
  assert.equal(readChatLinksIn(storing("anything")), "bloks");
  assert.equal(readChatLinksIn({ getItem: () => { throw new Error("storage refused"); } }), "bloks");
  assert.equal(readChatLinksIn(undefined), "bloks");
});

test("the setting is on the Browser page, found by settings search, and said in every language", () => {
  const browser = SETTINGS_PAGE_INDEX.find((page) => page.id === "browser")!;
  assert.ok(browser.rows.includes("settingsPages.browser.row.openChatLinksIn"));
  const page = readFileSync(new URL("../src/components/settings/BrowserPage.tsx", import.meta.url), "utf8");
  assert.match(page, /useChatLinksIn\(\)/);
  for (const lang of ["en", "es", "fr", "de", "pt-BR", "ja", "zh-CN"]) {
    const words = JSON.parse(readFileSync(new URL(`../src/locales/${lang}.json`, import.meta.url), "utf8"));
    for (const key of ["browserPage.openChatLinksIn", "browserPage.bloksBrowser", "browserPage.myBrowser", "settingsPages.browser.row.openChatLinksIn"]) {
      assert.equal(typeof words[key], "string", `${lang} ${key}`);
    }
  }
  // both chats ask the same question before handing a link to the dock
  for (const view of ["ChatView", "RoomView"]) {
    const source = readFileSync(new URL(`../src/components/${view}.tsx`, import.meta.url), "utf8");
    assert.match(source, /openLink: linksOpenInDock\(browserWhere, chatLinksIn\)/, view);
  }
});
