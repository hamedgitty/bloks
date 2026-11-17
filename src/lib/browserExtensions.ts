// Chrome extensions in the Bloks browser (GitHub 510), as the settings
// page sees them: the shapes electron/browser-extensions.mjs answers
// with, through the desktop app's bridge. There is no server half: they
// live in the app's browser session, which only the app has.
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
  problem?: string;
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
