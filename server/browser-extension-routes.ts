// Chrome extensions in a server's own browser (GitHub 510): the owner's
// routes for them, from any of their own devices.
//
// The desktop app keeps the extensions of a workspace it runs itself, in
// its own browser session (electron/main.mjs). A server with no app
// behind it keeps a headless Chrome (server/server-browser.ts), and these
// are how the owner adds an extension to it, switches it, removes it and
// opens its popup or options page, from the desktop app or the server's
// own page alike.
//
// Adding sends a folder from the owner's device to the server, file by
// file, into a staging folder of its own, and nothing there runs: it is
// read and judged (inspectFolder) for the same review screen the desktop
// app shows, and only the owner's yes copies it into the workspace's
// extensions. A staged folder nobody added is gone within the hour.
//
// Every route is the owner's: /api/browser/* is refused to an agent's
// credential (server/app-browser.ts) and to a member, whose routes are
// listed (server/member-access.ts). No agent installs, switches, opens or
// sees an extension, or a picture of one of its pages.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { COPIES_DIR, MAX_BYTES, MAX_FILES, addFromFolder, inspectFolder, listView, removeExtension, setEnabled } from "./browser-extensions.mjs";
import { readInput, type ServerBrowser } from "./server-browser.ts";

/** Where staged folders wait, inside the copies folder so they are the
 * workspace's alone, under a name no slug can take. */
export const STAGING_DIR = ".staging";
/** How long a staged folder waits for the owner's yes. */
export const STAGING_MS = 60 * 60_000;
/** One file of an extension, at most: a password manager's largest
 * bundle is well under this. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export interface ExtensionRouteDeps {
  /** The workspace's data folder. */
  dataDir: string;
  /** The request carries an agent's credential: refused, whatever it asks. */
  agent?: boolean;
  /** This server's own browser; null where the desktop app keeps it. */
  own: ServerBrowser | null;
  /** Through Bloks Cloud: pictures spaced, as the tab's are. */
  relay?: boolean;
  query?: URLSearchParams;
  now?: () => number;
}

export interface ExtensionRouteAnswer {
  status: number;
  body: Record<string, unknown>;
}

/** A path a folder's file was sent under, made safe to write, or null:
 * relative, plain parts, no climbing out, no hidden tricks. */
export function stagedPath(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > 400) return null;
  if (raw.includes("\\") || raw.includes("\0") || raw.startsWith("/")) return null;
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.length > 200 || /[\u0000-\u001f\u007f]/.test(part))) return null;
  return parts.join("/");
}

const stagingRoot = (dataDir: string) => join(dataDir, COPIES_DIR, STAGING_DIR);

/** A staged folder by its id, or null for an id that is not one. */
function stagedDir(dataDir: string, id: string): string | null {
  if (!/^[a-f0-9]{24}$/.test(id)) return null;
  const dir = join(stagingRoot(dataDir), id);
  return existsSync(dir) ? dir : null;
}

/** Every staged folder older than an hour, gone. */
export function sweepStaging(dataDir: string, now = Date.now()) {
  const root = stagingRoot(dataDir);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      if (now - statSync(join(root, name)).mtimeMs > STAGING_MS) rmSync(join(root, name), { recursive: true, force: true });
    } catch {
      /* gone already */
    }
  }
}

/** Files and bytes in a staged folder so far. */
function tally(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const visit = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        files += 1;
        bytes += statSync(full).size;
      }
    }
  };
  visit(dir);
  return { files, bytes };
}

/** The view of the list a server's browser shows: judged against its own
 * Chrome, not the desktop app's Electron. */
const listed = (dataDir: string) => ({ where: "server", extensions: listView(dataDir, { host: "server" }) });

/**
 * The routes under /api/browser/extensions, or null for a path that is
 * not one. `readJson` and `readBytes` read the request's body, once.
 */
export async function browserExtensionRoute(
  method: string,
  path: string,
  readJson: () => Promise<unknown>,
  readBytes: (max: number) => Promise<Buffer>,
  deps: ExtensionRouteDeps,
): Promise<ExtensionRouteAnswer | null> {
  if (path !== "/api/browser/extensions" && !path.startsWith("/api/browser/extensions/")) return null;
  const { dataDir, own } = deps;
  if (deps.agent) return { status: 403, body: { error: "that is the person's; an agent uses /api/agent/browser" } };
  if (!own) return { status: 409, body: { error: "This workspace's browser is in the Bloks desktop app on the computer that runs it; add extensions there.", where: "app" } };
  const now = deps.now ?? Date.now;
  const rest = path.slice("/api/browser/extensions".length);

  if (rest === "") {
    if (method === "GET") return { status: 200, body: { ...listed(dataDir), view: own.extensionView() } };
    if (method !== "POST") return { status: 405, body: { error: "GET or POST" } };
    // the owner's yes to a folder they staged and looked at
    const body = ((await readJson()) ?? {}) as { staging?: unknown };
    const dir = stagedDir(dataDir, String(body.staging ?? ""));
    if (!dir) return { status: 404, body: { error: "Send the extension's folder again: what was sent is gone." } };
    try {
      const looked = inspectFolder(dir, { host: "server" });
      const entry = addFromFolder(dataDir, dir, now(), { from: `Sent from your device: ${looked.info.name} ${looked.info.version}` });
      const ses = own.extensionSession();
      if (ses) await setEnabled(ses, dataDir, entry.slug, true);
    } catch (error) {
      return { status: 422, body: { error: error instanceof Error ? error.message : String(error) } };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return { status: 200, body: listed(dataDir) };
  }

  if (rest === "/staging") {
    if (method !== "POST") return { status: 405, body: { error: "POST" } };
    sweepStaging(dataDir, now());
    const id = randomBytes(12).toString("hex");
    mkdirSync(join(stagingRoot(dataDir), id), { recursive: true, mode: 0o700 });
    return { status: 201, body: { id, maxFiles: MAX_FILES, maxBytes: MAX_BYTES, maxFileBytes: MAX_FILE_BYTES } };
  }

  const staged = /^\/staging\/([a-f0-9]{24})(\/files|\/look)?$/.exec(rest);
  if (staged) {
    const dir = stagedDir(dataDir, staged[1]);
    if (!dir) return { status: 404, body: { error: "Send the extension's folder again: what was sent is gone." } };
    if (!staged[2]) {
      if (method !== "DELETE") return { status: 405, body: { error: "DELETE" } };
      rmSync(dir, { recursive: true, force: true });
      return { status: 200, body: { ok: true } };
    }
    if (staged[2] === "/files") {
      if (method !== "PUT") return { status: 405, body: { error: "PUT" } };
      const rel = stagedPath(deps.query?.get("path"));
      if (!rel) return { status: 400, body: { error: "path is the file's place in the folder, as plain parts" } };
      const target = resolve(dir, rel);
      if (!target.startsWith(`${resolve(dir)}${sep}`)) return { status: 400, body: { error: "path is the file's place in the folder, as plain parts" } };
      const so = tally(dir);
      if (so.files >= MAX_FILES) return { status: 413, body: { error: `More than ${MAX_FILES} files.` } };
      let bytes: Buffer;
      try {
        bytes = await readBytes(MAX_FILE_BYTES);
      } catch {
        return { status: 413, body: { error: "One of its files is larger than 25 MB." } };
      }
      if (so.bytes + bytes.length > MAX_BYTES) return { status: 413, body: { error: "The folder is larger than 100 MB." } };
      if (existsSync(target)) return { status: 409, body: { error: `${rel} was sent twice.` } };
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes, { mode: 0o600, flag: "wx" });
      return { status: 200, body: { ok: true } };
    }
    // the look, before the owner says yes: the same review screen the
    // desktop app shows, judged against this server's Chrome
    if (method !== "POST") return { status: 405, body: { error: "POST" } };
    try {
      return { status: 200, body: { ...inspectFolder(dir, { host: "server" }), path: staged[1] } };
    } catch (error) {
      return { status: 200, body: { path: staged[1], error: error instanceof Error ? error.message : String(error) } };
    }
  }

  // the extension view: one of an extension's own pages, open for the owner
  if (rest === "/view/screen") {
    if (method !== "GET") return { status: 405, body: { error: "GET" } };
    const after = Math.max(0, Math.floor(Number(deps.query?.get("after") ?? 0)) || 0);
    const said = await own.extensionScreen(after, deps.relay ? { waitMs: 8_000, gapMs: 250 } : { waitMs: 20_000, gapMs: 0 });
    return { status: 200, body: said.frame ? { ...said.frame } : { seq: said.seq, ...(said.closed ? { closed: true } : {}) } };
  }
  if (rest === "/view/input") {
    if (method !== "POST") return { status: 405, body: { error: "POST" } };
    const read = readInput(await readJson());
    if ("error" in read) return { status: 400, body: { error: read.error } };
    const done = await own.extensionInput(read.events);
    return { status: done.ok ? 200 : 409, body: { ...done } };
  }
  if (rest === "/view/close") {
    if (method !== "POST") return { status: 405, body: { error: "POST" } };
    await own.closeExtensionPage();
    return { status: 200, body: { ok: true } };
  }

  const one = /^\/([a-z0-9-]{1,48})(\/open)?$/.exec(rest);
  if (one) {
    const slug = one[1];
    if (one[2]) {
      if (method !== "POST") return { status: 405, body: { error: "POST" } };
      const body = ((await readJson()) ?? {}) as { page?: unknown };
      const page = body.page === "options" ? "options" : body.page === "popup" ? "popup" : null;
      if (!page) return { status: 400, body: { error: "page is popup or options" } };
      try {
        const opened = await own.openExtensionPage(slug, page);
        return { status: opened.error ? 422 : 200, body: { ...opened } };
      } catch (error) {
        const missing = (error as { missing?: unknown } | null)?.missing;
        return { status: 503, body: { error: error instanceof Error ? error.message : String(error), ...(missing ? { missing } : {}) } };
      }
    }
    try {
      if (method === "PATCH") {
        const body = ((await readJson()) ?? {}) as { enabled?: unknown };
        if (typeof body.enabled !== "boolean") return { status: 400, body: { error: "enabled is true or false" } };
        await setEnabled(own.extensionSession(), dataDir, slug, body.enabled);
        return { status: 200, body: listed(dataDir) };
      }
      if (method === "DELETE") {
        removeExtension(own.extensionSession(), dataDir, slug);
        return { status: 200, body: listed(dataDir) };
      }
    } catch (error) {
      return { status: 404, body: { error: error instanceof Error ? error.message : String(error) } };
    }
    return { status: 405, body: { error: "PATCH or DELETE" } };
  }
  return { status: 404, body: { error: "no such extensions route" } };
}
