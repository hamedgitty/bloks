// Hand-written twin of fake-cdp-browser.mjs, for the tests that hold it.
import type { CdpLine } from "../../server/server-browser.ts";

export interface FakePageDef {
  title: string;
  text?: string;
  elements: Array<{ backendNodeId: number; role: string; name: string; nodeName?: string; attributes?: Record<string, string> }>;
}

export interface FakeTarget {
  targetId: string;
  url: string;
  title: string;
  openerId?: string;
  sessions: Set<string>;
  fetch: unknown[] | null;
  viewport: { width: number; height: number; scale: number } | null;
  userAgent: string | null;
  cast: Record<string, unknown> | null;
  frames: number;
  input: Array<Record<string, unknown> & { method: string }>;
  waiting: boolean;
}

export interface FakeBrowser {
  calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }>;
  targets: Map<string, FakeTarget>;
  readonly downloadPath: string;
  line: CdpLine;
  open(url: string): FakeTarget;
  popup(openerId: string, url: string): FakeTarget;
  follow(targetId: string, url: string): Promise<{ frameId: string; errorText?: string } | null>;
  repaint(targetId: string): void;
  download(guid: string, name: string, body?: string): void;
  close(): void;
  readonly closed: boolean;
}

export function fakeBrowser(options?: { pages?: Record<string, FakePageDef>; userAgent?: string }): FakeBrowser;
