// A file an agent shared, as the app finds and opens it.
//
// The same file reaches a person two ways: as a card the server posts,
// and as a link the agent writes in its reply. Both have to open the same
// viewer, so both are read here into one target. A link can be the route
// the server serves files at, or the path the agent saved the file to,
// which only the server can say anything about (GET
// /api/artifacts/resolve). The rules for what a name may be mirror
// safeName in server/artifacts.ts; the server judges again either way.

import { t } from "./i18n.ts";

export type FileTarget =
  | { kind: "artifact"; botId: string; name: string }
  | { kind: "path"; path: string };

/** What opens a file, by its type. */
export type Viewer = "iframe" | "pdf" | "image" | "video" | "table" | "sheet" | "markdown" | "text" | "none";

const MAX_DEPTH = 8;
const MAX_SEGMENT = 200;

/** A shared name as words, the way the server takes it, or null. */
export function cleanName(name: string): string | null {
  if (!name || name.length > 1024 || name.startsWith("/") || name.includes("\\")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  const parts = name.split("/");
  if (parts.length > MAX_DEPTH) return null;
  for (const part of parts) {
    if (!part || part.length > MAX_SEGMENT || part.startsWith(".") || part.trim() !== part) return null;
  }
  return parts.join("/");
}

/** Where a shared file is asked for. The name is one segment, encoded,
 * so a folder in it cannot be read as more of the route. */
export function artifactHref(botId: string, name: string): string {
  return `/api/bots/${botId}/artifacts/${encodeURIComponent(name)}`;
}

/** The route alone, or after this computer's own address, as an agent
 * may write it. */
const HREF = /^(?:https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?)?\/api\/bots\/([\w-]+)\/artifacts\/([^?#]+)(?:[?#].*)?$/i;

/**
 * A link's target as a shared file, or null for an ordinary link.
 *
 * The route itself is read here, decoded once and judged. A path (an
 * absolute one, one from the home folder, or a file: URL) is passed on
 * as a path for the server to resolve: what is shared is the server's
 * to say, and a phone or a remote desktop does not know where on that
 * computer the agents keep their files.
 */
export function fileTarget(href: string): FileTarget | null {
  const raw = href.trim();
  if (!raw) return null;
  const route = HREF.exec(raw);
  if (route) {
    let name: string;
    try {
      name = decodeURIComponent(route[2]);
    } catch {
      return null;
    }
    const clean = cleanName(name);
    return clean ? { kind: "artifact", botId: route[1], name: clean } : null;
  }
  if (/^file:\/\//i.test(raw)) return { kind: "path", path: raw };
  // an absolute path, never a protocol-relative URL ("//host/x")
  if (/^\/(?!\/)/.test(raw) || raw.startsWith("~/")) return { kind: "path", path: raw };
  return null;
}

/**
 * Whether a code span is worth offering to open: a path that reads like
 * a file in an agent's folder of deliverables. Agents write those paths
 * in backticks more often than as links, and any absolute path would make
 * every path in a coding conversation a button that answers "not shared".
 */
export function looksShared(code: string): boolean {
  const text = code.trim();
  if (!text || /\s{2,}|\n/.test(text) || text.length > 2048) return false;
  const target = fileTarget(text);
  if (!target) return false;
  if (target.kind === "artifact") return true;
  return /\/artifacts\/[\w-]+\/[^/].*\.[A-Za-z0-9]{1,8}$/.test(target.path);
}

/** The viewer for a file, from the type the server gave it and its name.
 * A video the browser cannot play still gets the video viewer, which
 * says so and offers the download. */
export function viewerFor(mime: string, name: string): Viewer {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (mime === "text/html") return "iframe";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (ext === "csv" || ext === "tsv") return "table";
  if (ext === "xlsx") return "sheet";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "txt" || ext === "json" || ext === "log" || mime === "text/plain") return "text";
  return "none";
}

/** The last segment, for a title where the whole path will not fit. */
export function fileBase(name: string): string {
  return name.split("/").pop() || name;
}

/** Why a shared file will not open here, said before anybody tries: this
 * window reaches its server through Bloks Cloud, which opens files up to
 * `openMaxBytes`, and the file is more (GitHub 366). Null when it will
 * open, or when nothing says how much the way here carries. */
export function tooLargeHere(size: number, openMaxBytes: number | null): string | null {
  if (!openMaxBytes || !(size > openMaxBytes)) return null;
  return t("sharedFile.tooLargeForCloud", { size: Math.floor(openMaxBytes / 1024 / 1024) });
}

/** Why a file did not open, in words for the person, from the status the
 * server answered. Retrying asks again for the file; it never starts a
 * turn, so it is safe to offer whatever went wrong. */
export function openFailure(status: number, said?: string): string {
  if (status === 404) return said?.trim() || t("sharedFile.gone");
  if (status === 401 || status === 403) return t("sharedFile.notAllowed");
  if (status === 413) return said?.trim() || t("sharedFile.tooLarge");
  if (status === 0) return t("sharedFile.unreachable");
  return said?.trim() || t("sharedFile.failed", { status: String(status) });
}

/** Why a file did not open, as what the dialog can offer for it: a file
 * the server says was never shared into the chat (`shared: false`), a
 * way there that failed for now and may work on a second try, or an
 * answer that a second try would only repeat (gone, not allowed, too
 * large). */
export type FailureKind = "not-shared" | "temporary" | "final";

export function failureKind(status: number, body?: { shared?: unknown } | null): FailureKind {
  if (status === 404 && body?.shared === false) return "not-shared";
  if (status === 0 || status === 408 || status === 429 || status >= 500) return "temporary";
  return "final";
}

/** The buttons beside Close. Try again only where a second try can
 * differ (GitHub 543): asking again for a file that was not shared gets
 * the same answer. Request share only for a file that was not shared, and
 * only where the chat offers it, which is the owner's own chat with the
 * agent: it writes a message there for them to read and send, and never
 * sends one itself. A link is not access: the file opens once the agent
 * has shared it, through the same checks as any shared file. */
export function failureActions(kind: FailureKind, canRequest: boolean): { tryAgain: boolean; requestShare: boolean } {
  return { tryAgain: kind === "temporary", requestShare: kind === "not-shared" && canRequest };
}

/** The path a link names, as the agent will read it: a file: URL as the
 * path it stands for, anything else exactly as written. */
export function linkPath(href: string): string {
  const raw = href.trim();
  if (!/^file:\/\//i.test(raw)) return raw;
  try {
    const path = decodeURIComponent(new URL(raw).pathname);
    // file:///C:/x is C:/x on Windows
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path || raw;
  } catch {
    return raw;
  }
}

/** The words Request share puts in the composer: the exact path, as code
 * so nothing in it reads as formatting, and what to do if it cannot. */
export function shareRequestText(href: string): string {
  const path = linkPath(href);
  const code = path.includes("`") ? `\`\` ${path} \`\`` : `\`${path}\``;
  return t("sharedFile.requestShareMessage", { path: code });
}
