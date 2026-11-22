// Chrome extensions in the Bloks browser (GitHub 510), as the settings
// page and the browser's extensions button see them: the shapes
// server/browser-extensions.mjs answers with, through the desktop app's
// bridge for a workspace it runs, or a server's routes for the browser
// that server keeps (server/browser-extension-routes.ts).
export interface BrowserExtensionInfo {
  name: string;
  version: string;
  description: string;
  manifestVersion: 2 | 3 | null;
  permissions: string[];
  hosts: string[];
  contentScripts: number;
  background: "service worker" | "page" | null;
  popup: boolean;
}

export interface Compatibility {
  verdict: "works" | "partly" | "unlikely";
  works: string[];
  missing: string[];
}

export interface BrowserExtensionRow {
  slug: string;
  name: string;
  version: string;
  enabled: boolean;
  from: string;
  addedAt: number;
  info?: BrowserExtensionInfo;
  compatibility?: Compatibility;
  /** Which of its own pages it has to open; absent from an app before 3.2.11. */
  pages?: { popup: boolean; options: boolean };
  problem?: string;
}

/** An extension's own pages the owner opens from the browser's
 * extensions button: its toolbar popup and its options page. */
export type ExtensionPage = "popup" | "options";

/** One of them, open for the person in a server's browser, which shows
 * it as pictures of a page of its own (server/server-browser.ts). */
export interface ExtensionViewState {
  slug: string;
  name: string;
  page: ExtensionPage;
  width: number;
  height: number;
}

/** What the extensions button lists: each one switched on, working, with
 * a popup or an options page to open, in the order they were added. */
export function openableExtensions(rows: readonly BrowserExtensionRow[]): Array<{ slug: string; name: string; popup: boolean; options: boolean }> {
  return rows
    .filter((row) => row.enabled && !row.problem && (row.pages?.popup || row.pages?.options))
    .map((row) => ({ slug: row.slug, name: row.name, popup: Boolean(row.pages?.popup), options: Boolean(row.pages?.options) }));
}

export interface BrowserExtensionLook {
  path: string;
  bytes?: number;
  files?: number;
  info?: BrowserExtensionInfo;
  compatibility?: Compatibility;
  error?: string;
}

/** The hosts an extension reaches, said shortly: every site, or the first
 * few by name. */
export function hostsLine(hosts: readonly string[]): { all: boolean; shown: string[]; more: number } {
  const all = hosts.some((h) => h === "<all_urls>" || /^\*:\/\/\*\/\*$/.test(h) || /^https?:\/\/\*\/\*$/.test(h));
  const shown = all ? [] : hosts.slice(0, 4);
  return { all, shown, more: all ? 0 : Math.max(0, hosts.length - shown.length) };
}

/** A file's place in a folder the person chose, as the browser names it
 * ("vault/popup/index.html"), without the folder's own name: its place
 * in the extension. Empty for a name with no place in it. */
export function folderPath(relative: string): string {
  const parts = String(relative ?? "").split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join("/") : "";
}
