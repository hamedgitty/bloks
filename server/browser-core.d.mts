// Hand-written twin of browser-core.mjs, so the server, the tests and
// the app's own files typecheck against the shapes the code uses.

export const MAX_TABS: number;
export const READ_LIMIT: number;
export const SNAPSHOT_LIMIT: number;
export const WAIT_LIMIT_MS: number;
export const AGENT_IDLE_MS: number;
export const DIALOG_WAIT_MS: number;
export const DIALOG_TEXT_LIMIT: number;
export const PROMPT_LIMIT: number;
export const PEEK_WAIT_MS: number;
export const LEAVE_ARM_MS: number;
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

export type DialogType = "alert" | "confirm" | "prompt" | "beforeunload";

/** A page's dialog as the panel is shown it. */
export interface DialogShown {
  id: string;
  type: DialogType;
  message: string;
  defaultPrompt?: string;
  /** A yes only lets the next try to leave through. */
  again?: true;
}

/** A page's dialog as an agent is told of it. */
export interface DialogTold {
  id: string;
  type: DialogType;
  message: string;
  defaultPrompt?: string;
  /** The page waits on it; false where the app already stayed. */
  held: boolean;
}

/** What became of a dialog an agent was told of, or that opened while
 * it drove. */
export interface DialogNote {
  tab: string;
  type: DialogType;
  message: string;
  how: "timeout" | "accepted" | "dismissed" | "closed";
}

/** A dialog a tab has open, as the browser keeps it. */
export interface OpenDialog {
  id: string;
  type: DialogType;
  message: string;
  defaultPrompt: string;
  held: boolean;
  answer(accept: boolean, text: string): unknown;
  redo: (() => void) | null;
  step: Command | null;
  told: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

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
  /** A step a dialog cut short, still running on to its end. */
  cutShort?: Promise<unknown> | null;
  pollMs?: number;
  /** The dialog the page has open, if any (AppBrowser.dialogOpened). */
  dialog?: OpenDialog | null;
  dialogWaiters?: Array<() => void>;
  /** Until when a "leave this page?" is let through (the app's). */
  leaving?: number;
  /** The step running on it, and which run it is. */
  step?: Command | null;
  run?: number;
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
  /** The dialog command's answer. */
  answer?: "accept" | "dismiss";
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
  /** The page stopped on a dialog, which the agent answers. */
  dialog?: DialogTold;
  dialogNotes?: DialogNote[];
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
  tabs: Array<{ id: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; by: TabBy; dialog?: DialogShown }>;
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
export function readDialog(raw: unknown): { type: DialogType; message: string; defaultPrompt: string };
export function dialogOutcome(dialog: { type: DialogType }, accept: boolean, text?: string): string;
export function downloadName(suggested: string, taken: (name: string) => boolean): string;

export class AppBrowser {
  constructor(options: {
    makeTab: (id: string) => TabHandle;
    onChange?: (state: BrowserState) => void;
    now?: () => number;
    idleMs?: number;
    dialogMs?: number;
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
  dialogOpened(
    tabId: string,
    dialog: { type?: string; message?: string; defaultPrompt?: string; answer?: (accept: boolean, text: string) => unknown; held?: boolean; redo?: (() => void) | null },
  ): string | null;
  dialogClosed(tabId: string): void;
  answerDialog(
    id: string,
    answer: { accept?: boolean; text?: string },
    by?: "person" | "agent" | "clock",
  ): Promise<{ ok: true; error?: undefined; tab: TabHandle; dialog: OpenDialog; accept: boolean; text?: string } | { error: string; ok?: undefined }>;
  watchDialog(tab: TabHandle): { opened: Promise<void>; stop(): void };
  command(command: Command, driver: { botId: string; name: string }): Promise<TabAnswer>;
  peek(id: string, options?: { waitMs?: number }): Promise<TabPeek>;
}

/** A tab read for the person's mention of it: its words, or why not. */
export interface TabPeek {
  tab?: string;
  url?: string;
  title?: string;
  text?: string;
  error?: "closed" | "dialog" | "unreadable";
}
