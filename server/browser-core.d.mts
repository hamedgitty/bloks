// Hand-written twin of browser-core.mjs, so the server, the tests and
// the app's own files typecheck against the shapes the code uses.

export const MAX_TABS: number;
export const READ_LIMIT: number;
export const SNAPSHOT_LIMIT: number;
export const WAIT_LIMIT_MS: number;
export const AGENT_IDLE_MS: number;
export const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }>;
export const FIELD_WORDS: Record<"password" | "payment" | "file", string>;

export type FieldKind = "password" | "payment" | "file";

export interface AxNode {
  nodeId: string | number;
  parentId?: string | number;
  childIds?: Array<string | number>;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  properties?: Array<{ name: string; value?: { value?: unknown } }>;
  backendDOMNodeId?: number;
}

export interface NavigationPolicy {
  deny?: string[];
  /** Only these, when the workspace asks first; absent for Auto. */
  only?: string[] | null;
}

export type TabBy = { kind: "person" } | { kind: "agent"; botId: string; name: string };

/** One tab, as the browser drives it. The app makes these from a
 * WebContentsView, the server from a page of its own Chrome, and the
 * tests from a fake debugger. */
export interface TabHandle {
  id?: string;
  by?: TabBy;
  refs?: Map<string, number>;
  policy?: NavigationPolicy | null;
  blocked?: string | null;
  acting?: boolean;
  pollMs?: number;
  cdp(method: string, params?: Record<string, unknown>): Promise<any>;
  url(): string;
  title(): string;
  load(url: string): void;
  loading?(): boolean;
  canGoBack?(): boolean;
  canGoForward?(): boolean;
  close?(): void;
}

export interface Command {
  action: string;
  url?: string;
  ref?: string;
  text?: string;
  value?: string;
  key?: string;
  direction?: "up" | "down" | "top" | "bottom";
  gone?: string;
  ms?: number;
  path?: string;
  tab?: string;
  newTab?: boolean;
  append?: boolean;
  submit?: boolean;
  approved?: boolean;
  policy?: NavigationPolicy | null;
}

export interface TabAnswer {
  text?: string;
  image?: string;
  mime?: string;
  error?: string;
  needs?: { kind: FieldKind; ref: string };
  blocked?: string;
  held?: boolean;
  control?: Control;
  tab?: string;
  url?: string;
  title?: string;
  tabs?: BrowserState["tabs"];
  activeTabId?: string | null;
}

export interface Download {
  id: string;
  name: string;
  path: string;
  bytes: number;
  total: number;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  at: number;
  by?: string;
}

export type Control =
  | { by: "idle" }
  | { by: "agent"; botId: string; name: string; since: number }
  | { by: "person"; since: number; from?: { botId: string; name: string }; waiting?: { botId: string; name: string } };

export interface BrowserState {
  tabs: Array<{ id: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; by: TabBy }>;
  activeTabId: string | null;
  control: Control;
  downloads: Download[];
}

export function refusedNavigation(url: string, options?: { ownPorts?: Array<number | string> }): string | null;
export function hostOf(url: string): string;
export function hostMatches(host: string, pattern: string): boolean;
export function allowedForAgent(url: string, policy: NavigationPolicy | null | undefined): boolean;
export function addressFor(typed: string): string | null;
export function fieldKind(node: { nodeName?: string; localName?: string; attributes?: string[] } | null | undefined): FieldKind | null;
export function formatAxSnapshot(
  nodes: AxNode[],
  options?: { url?: string; title?: string; limit?: number },
): { text: string; refs: Map<string, number>; count: number };
export function keyNamed(name: string): { key: string; code: string; keyCode: number; text?: string } | null;
export function runOnTab(tab: TabHandle, command: Command): Promise<TabAnswer>;
export function downloadName(suggested: string, taken: (name: string) => boolean): string;

export class AppBrowser {
  constructor(options: {
    makeTab: (id: string) => TabHandle;
    onChange?: (state: BrowserState) => void;
    now?: () => number;
    idleMs?: number;
    ownPorts?: () => Array<number | string>;
  });
  state(): BrowserState;
  changed(): void;
  tab(id: string): TabHandle | null;
  readonly active: TabHandle | null;
  readonly control: Control;
  newTab(by?: TabBy): TabHandle;
  select(id: string): boolean;
  close(id: string): boolean;
  closeAll(): void;
  takeOver(): void;
  giveBack(): void;
  release(botId?: string): void;
  navigate(typed: string): { ok?: true; url?: string; error?: string };
  noteDownload(download: Download): void;
  clearDownloads(): void;
  command(command: Command, driver: { botId: string; name: string }): Promise<TabAnswer>;
}
