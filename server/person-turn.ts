// A Telegram person's native session has no standing owner permissions.
// These checks run before any of the person's words reach the engine.
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { MAX_PERSON_PROJECT_BYTES, MAX_TELEGRAM_REPLY_CHARS } from "./limits.ts";

export interface PersonTurn {
  /** Bound by the harness to this turn, sender and transport. No target. */
  reply(input: unknown): Promise<string>;
}

export const PERSON_REPLY_TOOL = {
  name: "reply_to_sender",
  description: "Send text to the person who started this turn. This is the only way your answer reaches them. It has no target argument.",
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
export function personTurnHold(why: string, next = "Choose a supported file login or Claude Code to let it answer."): Error {
  return new Error(HOLD + why + " The agent did not answer this request. " + next);
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

export interface PrivateCodexHome {
  path: string;
  configFile: string;
  socketPath: string;
  close(): void;
}

/** Same file, not a copy: a token refresh must update the owner's login. */
export function makePersonCodexHome(ownerConfig: any, helper: string, executable: string, cwd?: string): PrivateCodexHome {
  const settings = ownerConfig?.config;
  if (!settings || settings.cli_auth_credentials_store !== "file") {
    throw personTurnHold("Codex needs an existing file login for person turns. Keyring logins are not supported here.");
  }
  if ((settings.model_provider && settings.model_provider !== "openai") ||
      !empty(settings.model_providers?.openai) || settings.openai_base_url) {
    throw personTurnHold("the selected Codex provider depends on the owner's configuration, which is not loaded in person turns.");
  }
  const ownerHome = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
  const auth = join(ownerHome, "auth.json");
  if (!existsSync(auth)) throw personTurnHold("Codex needs an existing auth.json file login. No login was copied or changed.");
  try { JSON.parse(readFileSync(auth, "utf8")); }
  catch { throw personTurnHold("Codex's file login could not be read. No login was copied or changed."); }
  const path = mkdtempSync(join(tmpdir(), "bloks-person-codex-"));
  chmodSync(path, 0o700);
  const configFile = join(path, "config.toml");
  const socketPath = join(path, "reply.sock");
  try {
    const folder = realpathSync(cwd ?? process.cwd());
    const inside = relative(folder, realpathSync(path));
    if (!inside || (!isAbsolute(inside) && inside !== ".." && !inside.startsWith(".." + sep))) {
      throw personTurnHold("the agent folder contains the temporary session folder. Choose a narrower agent folder for person turns.");
    }
    symlinkSync(auth, join(path, "auth.json"));
    writeFileSync(configFile, [
      'approval_policy = "on-request"',
      'approvals_reviewer = "user"',
      'sandbox_mode = "read-only"',
      'web_search = "disabled"',
      'cli_auth_credentials_store = "file"',
      '[features]',
      'apps = false',
      'plugins = false',
      'memories = false',
      '[mcp_servers.bloks_reply]',
      `command = ${JSON.stringify(executable)}`,
      `args = ${JSON.stringify([helper, socketPath])}`,
      'default_tools_approval_mode = "approve"',
      '[mcp_servers.bloks_reply.env]',
      'ELECTRON_RUN_AS_NODE = "1"',
      'BLOKS_PUBLISH = "reply_to_sender"',
      '',
    ].join("\n"), { mode: 0o600 });
    return { path, configFile, socketPath, close: () => rmSync(path, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    throw error;
  }
}

const empty = (value: unknown) => value === undefined || value === null ||
  (typeof value === "object" && Object.keys(value).length === 0);

/** An unreadable path is not evidence that standing rules are absent. */
function absent(path: string): boolean {
  try { statSync(path); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}

export function checkPersonCodexConfig(answer: any, configFile: string): void {
  const config = answer?.config;
  if (!config || !Array.isArray(answer.layers) || config.approval_policy !== "on-request" ||
      config.approvals_reviewer !== "user" || config.sandbox_mode !== "read-only" ||
      config.web_search !== "disabled" ||
      config.cli_auth_credentials_store !== "file" || config.features?.apps !== false ||
      config.features?.plugins !== false || !empty(config.permissions) || !empty(config.default_permissions) ||
      !empty(config.hooks) || !empty(config.profiles) || !empty(config.auto_review) ||
      (config.profile !== undefined && config.profile !== null) ||
      Object.keys(config.mcp_servers ?? {}).join(",") !== "bloks_reply" ||
      config.mcp_servers.bloks_reply.default_tools_approval_mode !== "approve") {
    throw personTurnHold("Codex did not report the required read-only settings and reply-only tools.");
  }
  for (const layer of answer.layers) {
    if (!layer || !layer.config || typeof layer.config !== "object") throw personTurnHold("Codex did not report a configuration layer's contents.");
    if (layer.disabledReason) continue;
    if (layer.name?.type === "user" && resolve(layer.name.file ?? "") === resolve(configFile)) continue;
    // The default missing system file is reported as an empty layer.
    // Its folder can still supply exec rules, even with an empty config.
    if (layer.name?.type === "system" && empty(layer.config) && typeof layer.name.file === "string") {
      const file = resolve(layer.name.file), folder = dirname(file);
      if ([file, join(folder, "rules"), join(folder, "hooks"), join(folder, "hooks.json")].every(absent)) continue;
    }
    throw personTurnHold("a system, managed or project configuration layer could add standing permissions.");
  }
}

export function checkPersonCodexThread(answer: any): void {
  if (answer?.approvalPolicy !== "on-request" || answer.approvalsReviewer !== "user" ||
      answer.sandbox?.type !== "readOnly" || answer.sandbox.networkAccess !== false ||
      answer.activePermissionProfile !== null) {
    throw personTurnHold("Codex did not report a read-only, no-network thread with owner approvals.");
  }
}

export function checkPersonCodexTools(answer: any): void {
  if (!Array.isArray(answer?.data) || answer.nextCursor || answer.data.length !== 1 ||
      answer.data[0].name !== "bloks_reply" ||
      Object.keys(answer.data[0].tools ?? {}).join(",") !== "reply_to_sender") {
    throw personTurnHold("Codex mounted tools outside the reply server, or the reply tool is unavailable.");
  }
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
