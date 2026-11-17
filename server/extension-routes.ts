// The routes for workspace extensions (server/extensions.ts has the
// rules), and the little that is kept on disk for them.
//
// Who reaches these is decided before they are asked: the owner, from
// this computer's window or a device of their own, never a member and
// never an agent (NEVER in server/agent-cli.ts, and the asAgent line in
// server/index.ts). Installing reads a folder on this computer, so it is
// this computer's window only. A framed document's calls come through
// the app's page, which checked the message's shape; here the
// permission is checked again, against what the owner granted, since the
// page is only the messenger.
//
// On disk, in the workspace's data folder:
//   extensions.json        the installed list, what each was granted, 0600
//   extensions/<id>/       each one's files, as approved
//   extension-data/<id>.json   what each keeps with storage.set, 0600
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isRecord, readSaved, writeFileAtomic } from "./atomic-write.ts";
import {
  EXTENSION_LIMITS,
  FRAME_HEADERS,
  FolderRefused,
  PAGE_METHODS,
  SERVER_METHODS,
  agentsForExtension,
  entryFor,
  extensionMessage,
  folderName,
  frameExtensionDocument,
  manifestIn,
  mayCall,
  messageRoom,
  patchSettings,
  permissionWords,
  readInstalled,
  samePermissions,
  settingsOf,
  snapshotFolder,
  storageChange,
  writeInstalled,
  type ExtensionRecord,
  type Permission,
  type Storage,
} from "./extensions.ts";
import { themeFrom } from "./mcp-apps.ts";

export interface ExtensionDeps {
  dataDir: string;
  appVersion: string;
  /** This computer's own window, which may install from a folder here. */
  fromThisComputer: boolean;
  /** The workspace's agents, as the store has them. */
  bots: () => ReadonlyArray<{ id: string; name: string; hidden?: boolean; archivedAt?: number; solo?: { by: string }; tasks?: ReadonlyArray<{ busy?: boolean }> }>;
  /** Why this agent cannot take a message now, or null when it can. */
  refusal: (botId: string) => string | null;
  /** Hands an extension's framed words to an agent, as a webhook's are. */
  send: (botId: string, text: string) => Promise<{ queued: boolean; laneId?: string }>;
  /** Tells the owner's windows the list changed. */
  changed: () => void;
  now?: () => number;
}

export type RouteAnswer = { status: number; body: unknown } | { status: number; html: string; headers: Record<string, string> };

/** The installed list and each one's storage, read and written whole. */
export class ExtensionStore {
  readonly file: string;
  readonly root: string;
  readonly dataRoot: string;
  records: ExtensionRecord[];
  /** When each sent its recent messages to agents, by id. In memory: a
   * restart forgets them, which costs at most one more hour's worth. */
  readonly sent = new Map<string, number[]>();

  constructor(dataDir: string) {
    this.file = join(dataDir, "extensions.json");
    this.root = join(dataDir, "extensions");
    this.dataRoot = join(dataDir, "extension-data");
    let saved: unknown[] = [];
    try {
      const read = readSaved<Record<string, unknown>>(this.file, { extensions: [] }, isRecord);
      saved = Array.isArray(read.extensions) ? read.extensions : [];
    } catch {
      saved = [];
    }
    this.records = saved.filter(looksLikeRecord);
  }

  get(id: string): ExtensionRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  save(): void {
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileAtomic(this.file, `${JSON.stringify({ extensions: this.records }, null, 2)}\n`, 0o600);
  }

  storageOf(id: string): Storage {
    try {
      return readSaved<Storage>(this.storageFile(id), {}, isRecord);
    } catch {
      return {};
    }
  }

  saveStorage(id: string, value: Storage): void {
    mkdirSync(this.dataRoot, { recursive: true, mode: 0o700 });
    writeFileAtomic(this.storageFile(id), JSON.stringify(value), 0o600);
  }

  remove(id: string): void {
    this.records = this.records.filter((r) => r.id !== id);
    this.save();
    rmSync(join(this.root, id), { recursive: true, force: true });
    rmSync(this.storageFile(id), { force: true });
    this.sent.delete(id);
  }

  private storageFile(id: string): string {
    return join(this.dataRoot, `${id}.json`);
  }
}

function looksLikeRecord(value: unknown): value is ExtensionRecord {
  const v = value as ExtensionRecord;
  return Boolean(v && typeof v.id === "string" && v.manifest && typeof v.manifest.id === "string" && Array.isArray(v.granted) && typeof v.digest === "string");
}

/** An installed extension as the owner's windows see it. */
export function extensionView(store: ExtensionStore, record: ExtensionRecord) {
  const m = record.manifest;
  return {
    id: record.id,
    name: m.name,
    version: m.version,
    description: m.description,
    ...(m.author ? { author: m.author } : {}),
    bloks: m.bloks,
    enabled: record.enabled,
    permissions: permissionWords(record.granted),
    panels: m.panels.map((p) => ({ id: p.id, title: p.title })),
    background: Boolean(m.background),
    commands: m.commands,
    events: m.events,
    settings: m.settings,
    values: settingsOf(record),
    source: record.source.kind === "folder" ? { kind: "folder", path: record.source.path, name: folderName(record.source.path) } : record.source,
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
    // the files on disk are still the ones approved; if not, nothing of
    // it is served and the page says why
    intact: readInstalled(store.root, record) !== null,
  };
}

const PATH_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const WHICH = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The folder's look before install: what it is, what it asks for, what
 * is wrong with it, and how it differs from the copy installed. */
function inspectFolder(store: ExtensionStore, path: string, appVersion: string) {
  const snapshot = snapshotFolder(path);
  const verdict = manifestIn(snapshot, appVersion);
  const m = verdict.manifest;
  const had = m ? store.get(m.id) : undefined;
  if (m && !had && store.records.length >= EXTENSION_LIMITS.installed) {
    verdict.problems.push(`A workspace keeps at most ${EXTENSION_LIMITS.installed} extensions.`);
  }
  return {
    snapshot,
    view: {
      ok: verdict.problems.length === 0,
      problems: verdict.problems,
      digest: snapshot.digest,
      files: snapshot.files.length,
      bytes: snapshot.files.reduce((sum, f) => sum + f.bytes.length, 0),
      ...(m
        ? {
            manifest: {
              id: m.id,
              name: m.name,
              version: m.version,
              description: m.description,
              ...(m.author ? { author: m.author } : {}),
              bloks: m.bloks,
              panels: m.panels.map((p) => ({ id: p.id, title: p.title })),
              background: Boolean(m.background),
              commands: m.commands,
              events: m.events,
              settings: m.settings,
            },
            permissions: permissionWords(m.permissions),
          }
        : {}),
      ...(m && had
        ? {
            installed: {
              version: had.manifest.version,
              // asked for now and not granted before: said on their own,
              // since an update is where a permission slips in
              added: m.permissions.filter((p) => !had.granted.includes(p)),
              removed: had.granted.filter((p) => !m.permissions.includes(p)),
            },
          }
        : {}),
    },
    manifest: m,
  };
}

export async function extensionsRoute(
  store: ExtensionStore,
  method: string,
  path: string,
  url: URL,
  readBody: () => Promise<Record<string, unknown>>,
  deps: ExtensionDeps,
): Promise<RouteAnswer | null> {
  if (path !== "/api/extensions" && !path.startsWith("/api/extensions/")) return null;
  const now = deps.now ?? Date.now;
  const fail = (status: number, error: string): RouteAnswer => ({ status, body: { error } });

  if (path === "/api/extensions") {
    if (method === "GET") return { status: 200, body: { extensions: store.records.map((r) => extensionView(store, r)) } };
    if (method !== "POST") return fail(405, "GET or POST /api/extensions");
    // installing, or updating what is installed
    if (!deps.fromThisComputer) return fail(403, "Extensions are installed from a folder on this computer, in its own Bloks window.");
    const body = await readBody().catch(() => ({}) as Record<string, unknown>);
    const folder = typeof body.path === "string" ? body.path.trim() : "";
    if (!folder) return fail(400, "path is the extension's folder on this computer");
    let looked;
    try {
      looked = inspectFolder(store, folder, deps.appVersion);
    } catch (e) {
      return fail(400, e instanceof FolderRefused ? e.message : "That folder could not be read.");
    }
    const { snapshot, view, manifest } = looked;
    if (!manifest || !view.ok) return { status: 422, body: { error: view.problems[0] ?? "That extension cannot be installed.", problems: view.problems } };
    // what the owner saw is what lands: the same bytes, and the same
    // permissions, or nothing
    if (body.digest !== snapshot.digest) return fail(409, "The folder changed after you looked at it. Look again before installing.");
    if (!Array.isArray(body.grant) || !samePermissions(body.grant as string[], manifest.permissions)) {
      return fail(409, "The permissions to grant are not the ones this extension asks for. Look again before installing.");
    }
    const had = store.get(manifest.id);
    try {
      writeInstalled(store.root, manifest.id, snapshot);
    } catch {
      return fail(500, "The extension could not be copied into the workspace.");
    }
    const at = now();
    // settings the new version still has keep the owner's values
    const kept = had ? Object.fromEntries(Object.entries(had.settings ?? {}).filter(([key]) => manifest.settings.some((s) => s.key === key))) : {};
    const record: ExtensionRecord = {
      id: manifest.id,
      manifest,
      source: { kind: "folder", path: folder },
      granted: [...manifest.permissions],
      enabled: had ? had.enabled : true,
      digest: snapshot.digest,
      installedAt: had?.installedAt ?? at,
      updatedAt: at,
      settings: kept,
    };
    store.records = had ? store.records.map((r) => (r.id === record.id ? record : r)) : [...store.records, record];
    store.save();
    deps.changed();
    return { status: had ? 200 : 201, body: { extension: extensionView(store, record) } };
  }

  if (path === "/api/extensions/inspect") {
    if (method !== "POST") return fail(405, "POST /api/extensions/inspect");
    if (!deps.fromThisComputer) return fail(403, "Extensions are installed from a folder on this computer, in its own Bloks window.");
    const body = await readBody().catch(() => ({}) as Record<string, unknown>);
    const folder = typeof body.path === "string" ? body.path.trim() : "";
    if (!folder) return fail(400, "path is the extension's folder on this computer");
    try {
      return { status: 200, body: inspectFolder(store, folder, deps.appVersion).view };
    } catch (e) {
      return fail(400, e instanceof FolderRefused ? e.message : "That folder could not be read.");
    }
  }

  const m = path.match(/^\/api\/extensions\/([^/]+)(?:\/(frame|call)(?:\/([^/]+))?)?$/);
  if (!m || !PATH_ID.test(m[1])) return fail(404, "no such extension");
  const record = store.get(m[1]);
  if (!record) return fail(404, "no such extension");

  if (!m[2]) {
    if (method === "GET") return { status: 200, body: { extension: extensionView(store, record) } };
    if (method === "DELETE") {
      // its files, its storage and its place in the list; its panels and
      // commands go from every window with the next list
      store.remove(record.id);
      deps.changed();
      return { status: 200, body: { removed: record.id } };
    }
    if (method === "PATCH") {
      const body = await readBody().catch(() => ({}) as Record<string, unknown>);
      let next = record;
      if ("enabled" in body) {
        if (typeof body.enabled !== "boolean") return fail(400, "enabled is true or false");
        next = { ...next, enabled: body.enabled };
      }
      if ("settings" in body) {
        const patched = patchSettings(record.manifest, record.settings ?? {}, body.settings);
        if (!patched.ok) return fail(400, patched.error);
        next = { ...next, settings: patched.settings };
      }
      store.records = store.records.map((r) => (r.id === record.id ? next : r));
      store.save();
      deps.changed();
      return { status: 200, body: { extension: extensionView(store, next) } };
    }
    return fail(405, "GET, PATCH or DELETE");
  }

  // Everything below is the running extension, which a switched-off one
  // is not.
  if (!record.enabled) return fail(409, `${record.manifest.name} is switched off.`);

  if (m[2] === "frame") {
    if (method !== "GET") return fail(405, "GET");
    const which = m[3] ?? "";
    if (!WHICH.test(which)) return fail(404, "no such document");
    const entry = entryFor(record.manifest, which);
    if (!entry) return fail(404, "no such document");
    const files = readInstalled(store.root, record);
    if (!files) return fail(409, `${record.manifest.name}'s files changed after it was installed, so it is not shown. Install it again to see what it is now.`);
    const byPath = new Map(files.files.map((f) => [f.path, f.bytes]));
    const html = byPath.get(entry);
    if (!html) return fail(404, "no such document");
    let theme: unknown = {};
    try {
      theme = JSON.parse(url.searchParams.get("theme") ?? "{}");
    } catch {
      /* the defaults, then */
    }
    return {
      status: 200,
      html: frameExtensionDocument(html.toString("utf8"), (p) => byPath.get(p) ?? null, themeFrom(theme)),
      headers: FRAME_HEADERS,
    };
  }

  // a call (m[2] === "call")
  if (method !== "POST" || m[3]) return fail(405, "POST /api/extensions/:id/call");
  const body = await readBody().catch(() => ({}) as Record<string, unknown>);
  const callMethod = typeof body.method === "string" ? body.method : "";
  const verdict = mayCall(record.granted, callMethod);
  if (!verdict.ok) return fail(403, verdict.error);
  if (Object.prototype.hasOwnProperty.call(PAGE_METHODS, callMethod)) return fail(400, `${callMethod} is answered by the app's page, not the server`);
  const params = body.params ?? null;
  if (Buffer.byteLength(JSON.stringify(params)) > EXTENSION_LIMITS.callBytes) return fail(413, "that call's parameters are more than 64 KB");
  try {
    return { status: 200, body: { result: await serverCall(store, record, callMethod as keyof typeof SERVER_METHODS, params, deps, now) } };
  } catch (e) {
    const refused = callRefusal(e);
    if (refused) return fail(400, refused);
    throw e;
  }
}

class CallRefused extends Error {}

async function serverCall(
  store: ExtensionStore,
  record: ExtensionRecord,
  method: keyof typeof SERVER_METHODS,
  params: unknown,
  deps: ExtensionDeps,
  now: () => number,
): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "agents.list":
      return agentsForExtension(deps.bots());
    case "settings.get":
      return settingsOf(record);
    case "storage.get": {
      const kept = store.storageOf(record.id);
      if (typeof p.key === "string") return Object.prototype.hasOwnProperty.call(kept, p.key) ? kept[p.key] : null;
      return kept;
    }
    case "storage.set":
    case "storage.remove": {
      const change = storageChange(store.storageOf(record.id), method, params);
      if (!change.ok) throw new CallRefused(change.error);
      store.saveStorage(record.id, change.next);
      return true;
    }
    case "agents.message": {
      const agentId = typeof p.agentId === "string" ? p.agentId : "";
      const text = typeof p.text === "string" ? p.text.trim() : "";
      if (!text) throw new CallRefused("text is the message to send");
      // only an agent the extension could have listed: the owner's own
      const agent = agentsForExtension(deps.bots()).find((a) => a.id === agentId);
      if (!agent) throw new CallRefused("no such agent of yours");
      const refused = deps.refusal(agent.id);
      if (refused) throw new CallRefused(refused);
      const room = messageRoom(store.sent.get(record.id) ?? [], now());
      if (!room.ok) throw new CallRefused(room.error);
      store.sent.set(record.id, room.kept);
      const sent = await deps.send(agent.id, extensionMessage(record.manifest.name, text));
      return { sent: true, queued: sent.queued };
    }
  }
}

/** A refused call as the route says it: the reason, never a stack. */
function callRefusal(e: unknown): string | null {
  return e instanceof CallRefused ? e.message : null;
}

/** Every call and the permission it needs, for the page's own table to
 * be checked against in a test. */
export function methodTable(): Record<string, Permission | null> {
  return { ...SERVER_METHODS, ...PAGE_METHODS };
}
