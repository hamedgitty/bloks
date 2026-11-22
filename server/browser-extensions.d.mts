// Hand-written twin of browser-extensions.mjs, so the tests typecheck
// against the same shapes the main process uses.
export const LIST_FILE: string;
export const COPIES_DIR: string;
export const MAX_EXTENSIONS: number;
export const MAX_BYTES: number;
export const MAX_FILES: number;

export interface BrowserExtensionInfo {
  name: string;
  version: string;
  description: string;
  manifestVersion: 2 | 3 | null;
  permissions: string[];
  optionalPermissions: string[];
  hosts: string[];
  contentScripts: number;
  background: "service worker" | "page" | null;
  popup: boolean;
  options: boolean;
  devtools: boolean;
  commands: boolean;
  overrides: boolean;
  sidePanel: boolean;
  externallyConnectable: boolean;
}

export interface Compatibility {
  verdict: "works" | "partly" | "unlikely";
  works: string[];
  missing: string[];
}

export interface BrowserExtensionEntry {
  slug: string;
  dir: string;
  from: string;
  name: string;
  version: string;
  enabled: boolean;
  addedAt: number;
  extensionId?: string;
  problem?: string;
}

export interface ExtensionSession {
  extensions?: ExtensionApi;
  loadExtension?: ExtensionApi["loadExtension"];
  removeExtension?: ExtensionApi["removeExtension"];
}

export interface ExtensionApi {
  loadExtension(path: string, options?: { allowFileAccess?: boolean }): Promise<{ id: string }>;
  removeExtension(id: string): void;
}

/** Which browser an extension is judged for: the desktop app's Electron,
 * or a server's own headless Chrome. */
export type ExtensionHost = "app" | "server";

export interface ExtensionPages {
  popup: string | null;
  options: string | null;
}

export function readBrowserExtension(dir: string): BrowserExtensionInfo;
export function compatibility(info: BrowserExtensionInfo, options?: { host?: ExtensionHost }): Compatibility;
export function pagesOf(dir: string): ExtensionPages;
export function pageUrl(extensionId: string, page: string): string | null;
export function isPageOf(url: string, extensionId: string): boolean;
export function readList(dataDir: string): BrowserExtensionEntry[];
export function writeList(dataDir: string, list: BrowserExtensionEntry[]): void;
export function inspectFolder(dir: string, options?: { host?: ExtensionHost }): { path: string; bytes: number; files: number; info: BrowserExtensionInfo; compatibility: Compatibility };
export function addFromFolder(dataDir: string, dir: string, now?: number, options?: { from?: string }): BrowserExtensionEntry;
export function loadInto(ses: ExtensionSession, dataDir: string, log?: (line: string) => void): Promise<string[]>;
export function setEnabled(ses: ExtensionSession | null, dataDir: string, slug: string, enabled: boolean): Promise<BrowserExtensionEntry>;
export function removeExtension(ses: ExtensionSession | null, dataDir: string, slug: string): void;
export function listView(dataDir: string, options?: { host?: ExtensionHost }): Array<{
  slug: string;
  name: string;
  version: string;
  enabled: boolean;
  from: string;
  addedAt: number;
  info?: BrowserExtensionInfo;
  compatibility?: Compatibility;
  pages: { popup: boolean; options: boolean };
  problem?: string;
}>;
