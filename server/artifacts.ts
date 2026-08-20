// Deliverables an agent leaves behind.
//
// Every agent gets a directory of its own under DATA_DIR. Its system
// prompt names the path; whatever the agent saves there during a turn
// surfaces in the chat as an artifact card the user can view in-app or
// download. Detection is a snapshot-and-diff around the turn, not a
// watcher: watchers are flaky across platforms and the interesting
// moment is "what did this turn produce", which a diff answers exactly.
import { mkdirSync, readdirSync, statSync, createReadStream, existsSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";

export interface ArtifactInfo {
  name: string;
  mime: string;
  size: number;
}

/** Filenames an agent may produce and we are willing to serve: a plain
 * name, no separators, no leading dot. Everything else stays invisible,
 * which is also the path-traversal guard. */
const SAFE_NAME = /^[\w][\w .()\-]{0,120}$/;

const MIME: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  zip: "application/zip",
};

export function mimeOf(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

export function artifactsDir(botId: string): string {
  const dir = join(DATA_DIR, "artifacts", botId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function artifactPath(botId: string, name: string): string | null {
  if (!SAFE_NAME.test(name)) return null;
  const file = join(artifactsDir(botId), name);
  return existsSync(file) ? file : null;
}

export function openArtifact(botId: string, name: string) {
  const file = artifactPath(botId, name);
  if (!file) return null;
  const stat = statSync(file);
  return { stream: createReadStream(file), size: stat.size, mime: mimeOf(name) };
}

/** name -> mtime+size fingerprint of everything currently in the dir. */
export function snapshot(botId: string): Map<string, string> {
  const seen = new Map<string, string>();
  try {
    for (const name of readdirSync(artifactsDir(botId))) {
      if (!SAFE_NAME.test(name)) continue;
      try {
        const stat = statSync(join(artifactsDir(botId), name));
        if (stat.isFile()) seen.set(name, `${stat.mtimeMs}:${stat.size}`);
      } catch {}
    }
  } catch {}
  return seen;
}

/** Files that are new or changed since `before`, newest last. */
export function producedSince(botId: string, before: Map<string, string>): ArtifactInfo[] {
  const produced: Array<ArtifactInfo & { at: number }> = [];
  const dir = artifactsDir(botId);
  try {
    for (const name of readdirSync(dir)) {
      if (!SAFE_NAME.test(name)) continue;
      try {
        const stat = statSync(join(dir, name));
        if (!stat.isFile()) continue;
        const print = `${stat.mtimeMs}:${stat.size}`;
        if (before.get(name) !== print) {
          produced.push({ name, mime: mimeOf(name), size: stat.size, at: stat.mtimeMs });
        }
      } catch {}
    }
  } catch {}
  return produced.sort((a, b) => a.at - b.at).map(({ at: _at, ...info }) => info);
}
