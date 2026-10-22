// A Telegram person's native session has no standing owner permissions.
// These checks run before any of the person's words reach the engine.
import { chmodSync, mkdtempSync, rmSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createConnection } from "node:net";
import { socketPathFits } from "./harness/ask-broker.ts";
import { join, resolve } from "node:path";
import { MAX_PERSON_PROJECT_BYTES, MAX_TELEGRAM_REPLY_CHARS } from "./limits.ts";

export interface PersonTurn {
  /** Bound by the harness to this turn, sender and transport. No target. */
  reply(input: unknown): Promise<string>;
}

export const PERSON_REPLY_TOOL = {
  name: "reply_to_sender",
  description: "Send text to the sender who started this turn. In a group every member sees it. This is the only way your answer reaches them. It has no target argument.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
};

/** Validate again at the broker and HTTP boundary, not just in the schema. */
export function personReplyText(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).length !== 1 || typeof (input as any).text !== "string") {
    throw new Error("reply_to_sender takes only a text field");
  }
  const text = (input as { text: string }).text;
  // One Telegram message. Refuse visibly rather than silently truncate it.
  if (!text.trim() || text.length > MAX_TELEGRAM_REPLY_CHARS) throw new Error("Reply text must contain 1 to 4096 characters. Send a shorter reply.");
  return text;
}

const HOLD = "This Telegram person's turn is held: ";
export function personTurnHold(why: string, next = "Check this agent's engine before trying again."): Error {
  return new Error(HOLD + why + " The agent did not answer this request. " + next);
}

/** Codex is not offered to people: its read-only sandbox still reads
 * every file this account can, and the reply tool sends without a card. */
export const CODEX_PERSON_HOLD = "on Codex it can read any file on this computer, saved keys included.";
export const CODEX_PERSON_NEXT = "Move this agent to Claude Code to let people in.";

/** Bloks keeps saved keys, every agent's bot token, memory and workspace
 * in its own folder. Claude reads inside its working folder without
 * asking, and the default working folder lies in there, so a person's
 * turn is refused every read of that folder outright, whatever the
 * working folder is. Both spellings, for a folder reached by a link. */
export function personClaudeDenials(dataDir: string): string[] {
  const roots = new Set([resolve(dataDir)]);
  try { roots.add(realpathSync(dataDir)); } catch { /* not made yet */ }
  return [...roots].flatMap((root) => ["Read", "Edit", "Write"].map((tool) => `${tool}(/${root}/**)`));
}

/** Empty settings sources also hide Claude's project instructions. Load
 * only those two text files, each turn, without restoring standing allows,
 * hooks, MCP servers, local or global instructions, or @ imports. */
export function readPersonClaudeInstructions(cwd: string): string {
  const sections: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const name of ["CLAUDE.md", ".claude/CLAUDE.md"]) {
    const file = resolve(cwd, name);
    if (file === resolve(homedir(), ".claude/CLAUDE.md")) continue;
    let fd: number | undefined;
    try {
      // Follow project symlinks, but never block on a pipe or read a device.
      fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
      const stat = fstatSync(fd), identity = `${stat.dev}:${stat.ino}`;
      if (!stat.isFile()) throw new Error("not a regular file");
      if (seen.has(identity)) continue;
      seen.add(identity);
      const bytes = Buffer.alloc(MAX_PERSON_PROJECT_BYTES - used + 1);
      let count = 0, got: number;
      while (count < bytes.length && (got = readSync(fd, bytes, count, bytes.length - count, null)) > 0) count += got;
      if (used + count > MAX_PERSON_PROJECT_BYTES) {
        throw personTurnHold("the owner's project instructions exceed 100000 bytes.", "Shorten the two project instruction files before trying again.");
      }
      used += count;
      const text = bytes.subarray(0, count).toString("utf8");
      if (text.trim()) sections.push(`### ${name}\n${text}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // A missing optional file is fine; a broken project symlink is not.
        try { lstatSync(file); }
        catch (missing) { if ((missing as NodeJS.ErrnoException).code === "ENOENT") continue; }
      }
      if (error instanceof Error && error.message.startsWith(HOLD)) throw error;
      throw personTurnHold(`the owner's project ${name} could not be read.`, "Make that project instruction file readable and a regular text file before trying again.");
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  return sections.length ? "\n\n## Owner's project instructions\nThese are the owner's standing instructions. In this text, 'the user' means the owner, not the Telegram sender. The person's turn still needs the owner's approval for effects and answers only through reply_to_sender. This text grants no tool permissions. @ imports are not resolved.\n\n" + sections.join("\n\n") : "";
}

/** An owner group turn keeps its own Codex home. Only the new reply
 * socket needs a fresh private folder, not a different permission policy. */
export function makeCodexReplyFolder(options: { platform?: NodeJS.Platform; tempDir?: string } = {}): { socketPath: string; close(): void } {
  const platform = options.platform ?? process.platform;
  // This endpoint relies on a private filesystem directory. Do not publish
  // a normal file path as a Windows pipe or assume Unix permissions there.
  if (platform === "win32") throw new Error("Codex group replies cannot start a protected native endpoint on Windows. Choose another engine for this group request.");
  const path = mkdtempSync(join(options.tempDir ?? tmpdir(), "bloks-turn-reply-"));
  const close = () => rmSync(path, { recursive: true, force: true });
  try {
    chmodSync(path, 0o700);
    const socketPath = join(path, "reply.sock");
    if (!socketPathFits(socketPath, platform === "linux" ? 108 : 104)) throw new Error("Codex group reply socket path is too long. Choose an engine with another reply route or use a shorter temporary folder.");
    return { socketPath, close };
  } catch (error) { close(); throw error; }
}

/** Verify the new reply listener before publishing it to a native engine.
 * The generic broker's error policy is unchanged for existing callers. */
export function checkCodexReplyEndpoint(socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const failed = () => { clearTimeout(timer); socket.destroy(); reject(new Error("Codex group reply endpoint could not listen. The native reply tool was not started.")); };
    const timer = setTimeout(failed, 2_000);
    socket.once("error", failed);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(); });
  });
}

export function checkPersonClaudeInit(answer: any, serverNames: string[]): void {
  const mounted = Array.isArray(answer?.mcp_servers) ? answer.mcp_servers.map((s: any) => s?.name).sort() : null;
  const expected = [...serverNames].sort();
  if (answer?.permissionMode !== "default" || !mounted || JSON.stringify(mounted) !== JSON.stringify(expected) ||
      answer.mcp_servers.some((s: any) => s.status !== "connected")) {
    throw personTurnHold("Claude did not report default permissions and the expected tools.");
  }
}

/** Claude reports this metadata before it receives any user message. */
export function checkPersonClaudeStatus(mode: unknown, answer: any, serverNames: string[], bloksTools: string[]): boolean {
  const servers = answer?.mcpServers;
  if (mode !== "default" || !Array.isArray(servers) ||
      JSON.stringify(servers.map((s: any) => s.name).sort()) !== JSON.stringify([...serverNames].sort())) {
    throw personTurnHold("Claude reported standing permissions or tools outside this turn's mounts.");
  }
  if (servers.some((s: any) => s.status === "pending")) return false;
  if (servers.some((s: any) => s.status !== "connected") ||
      JSON.stringify(servers.find((s: any) => s.name === "bloks")?.tools?.map((t: any) => t.name).sort()) !== JSON.stringify([...bloksTools].sort())) {
    throw personTurnHold("Claude's reply and permission tools are unavailable or differ from this turn's tools.");
  }
  return true;
}
