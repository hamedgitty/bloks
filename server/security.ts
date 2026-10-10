// The security checkup: everything that lets an agent, a device or a
// stranger reach further than the person may remember choosing, on one
// page, each with the way to narrow it.
//
// Every one of these was a deliberate choice somewhere in Settings, and
// most are right for the person who made them. What goes wrong is the
// choice made for one afternoon and never undone: full access for a
// migration, a webhook for a demo, pairing for a trip. So the checkup does
// not judge the settings, it lists them, says in one sentence why each
// matters, and only calls "risky" what nobody would choose with their eyes
// open: an agent nothing asks, and key files other accounts can read.
//
// Plain facts in, plain findings out. The server gathers the facts
// (securityReport in server/index.ts) and this file only decides what to
// say, so the wording and the levels are testable without a workspace.
// The fix for file modes lives here too, since it is the one fix that is
// not already a setting somewhere else.

import { chmodSync, existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** How much a finding wants the person's attention. */
export type Level = "ok" | "look" | "risky";

/** What the page offers for a finding. Links go to where the setting
 * already lives; actions are the few things the page does itself. */
export type Fix =
  | { kind: "page"; page: string; label: string }
  | { kind: "automations"; tab: "webhooks"; label: string }
  /** Each item is an agent: open its settings. */
  | { kind: "agents"; label: string }
  /** Each item is an agent in full access: move it to Auto, or open it. */
  | { kind: "full-access"; label: string }
  /** Each item is a room: open it. */
  | { kind: "rooms"; label: string }
  /** Each item is a saved secret: forget it. */
  | { kind: "secrets"; label: string }
  /** POST /api/security/permissions. */
  | { kind: "permissions"; label: string };

export interface Finding {
  id: "full-access" | "remote" | "email" | "shared-rooms" | "browser-computer" | "secrets" | "files" | "webhooks" | "engines" | "backups";
  title: string;
  level: Level;
  /** What was found, plainly. */
  summary: string;
  /** Why it matters, in one sentence. */
  why: string;
  /** The agents, rooms, engines, secrets or files it is about. */
  items?: Array<{ id: string; name: string; detail?: string }>;
  fix?: Fix;
}

/** One file or folder the checkup looks at, and what it should be. */
export interface FileCheck {
  /** As the person would write it: ~/.bloks/config.json. */
  name: string;
  path: string;
  /** Octal, as ls would say it: 0644. */
  mode: string;
  want: "0700" | "0600";
  /** Readable or writable by anyone but the owner. */
  open: boolean;
}

export interface SecurityFacts {
  agents: Array<{
    id: string;
    name: string;
    approvals: string;
    browser: boolean;
    /** May drive this machine's own screen and keyboard. */
    thisMachine: boolean;
    /** Its engine cannot switch its tools off, so it would refuse mail
     * from an address nobody listed (sharedSafe in server/index.ts). */
    refusesUnlistedMail: boolean;
  }>;
  remote: { enabled: boolean; relay: boolean; devices: number; memberDevices: number };
  email: { enabled: boolean; allowFrom: number };
  /** Shared rooms, with the owner's tools each one opens. */
  rooms: Array<{ id: string; name: string; ownerTools: string[] }>;
  secrets: string[];
  /** Null where the filesystem has no owner and group modes to check. */
  files: FileCheck[] | null;
  webhooks: number;
  /** Engines an agent uses that are signed out, with how many use each. */
  signedOut: Array<{ id: string; name: string; agents: number }>;
  /** Whether the daily backup is on. Absent from a build that does not
   * back up at all, which then says nothing about backups. */
  backups?: { auto: boolean };
  platform?: NodeJS.Platform;
}

/** "Ada", "Ada and Linus", "Ada, Linus and Kat", "Ada, Linus and 3 more". */
export function names(list: string[], most = 3): string {
  if (list.length <= 1) return list[0] ?? "";
  if (list.length <= most) return `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
  return `${list.slice(0, most - 1).join(", ")} and ${list.length - (most - 1)} more`;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function machine(platform: NodeJS.Platform | undefined): string {
  return platform === "darwin" ? "this Mac" : platform === "win32" ? "this PC" : "this computer";
}

const ORDER: Record<Level, number> = { risky: 0, look: 1, ok: 2 };

/** Every finding, the ones that want attention first. */
export function checkup(facts: SecurityFacts): Finding[] {
  const here = machine(facts.platform ?? process.platform);
  const findings: Finding[] = [];

  const full = facts.agents.filter((a) => a.approvals === "full");
  findings.push({
    id: "full-access",
    title: "Full access",
    level: full.length ? "risky" : "ok",
    summary: full.length
      ? `${names(full.map((a) => a.name))} ${full.length === 1 ? "runs" : "run"} in full access.`
      : "No agent runs in full access.",
    why: "In full access nothing asks first, not even the engine's own guard, so a command or an edit happens the moment the agent decides on it.",
    ...(full.length
      ? { items: full.map((a) => ({ id: a.id, name: a.name })), fix: { kind: "full-access", label: "Use Auto instead" } as Fix }
      : {}),
  });

  const r = facts.remote;
  findings.push({
    id: "remote",
    title: "Phone and remote access",
    level: r.enabled ? "look" : "ok",
    summary: r.enabled
      ? `Pairing is on${r.relay ? ", through Bloks Cloud too" : ""}, and ${count(r.devices, "device")} of yours can reach ${here}.` +
        (r.memberDevices ? ` ${count(r.memberDevices, "more device", "more devices")} belong to people in your shared rooms and reach only those rooms.` : "")
      : `Pairing is off, so no other device can reach Bloks on ${here}.`,
    why: "A paired device can do anything you can do here, so every one of them should be yours and still in your hands.",
    ...(r.enabled ? { fix: { kind: "page", page: "devices", label: "Review devices" } as Fix } : {}),
  });

  const refusing = facts.agents.filter((a) => a.refusesUnlistedMail);
  const openMail = facts.email.enabled && facts.email.allowFrom === 0;
  findings.push({
    id: "email",
    title: "Email to your agents",
    level: openMail ? "look" : "ok",
    summary: !facts.email.enabled
      ? "Email to your agents is off."
      : openMail
        ? "Anyone who has one of your agents' addresses can write to it." +
          (refusing.length
            ? ` ${names(refusing.map((a) => a.name))} ${refusing.length === 1 ? "runs on an engine" : "run on engines"} whose tools cannot be switched off, so ${refusing.length === 1 ? "it refuses" : "they refuse"} mail from anyone you have not listed.`
            : "")
        : `Only the ${count(facts.email.allowFrom, "address or domain", "addresses and domains")} you listed can write to your agents.`,
    why: "Mail from someone you have not listed is answered without your tools or memory, but it still starts turns on your engines and your bill.",
    ...(openMail
      ? {
          ...(refusing.length ? { items: refusing.map((a) => ({ id: a.id, name: a.name, detail: "refuses unlisted mail" })) } : {}),
          fix: { kind: "page", page: "chat", label: "Choose who may write" } as Fix,
        }
      : {}),
  });

  const opened = facts.rooms.filter((room) => room.ownerTools.length);
  findings.push({
    id: "shared-rooms",
    title: "Shared rooms",
    level: opened.length ? "look" : "ok",
    summary: opened.length
      ? `${names(opened.map((room) => room.name))} ${opened.length === 1 ? "opens" : "open"} your own tools to the people in ${opened.length === 1 ? "it" : "them"}.`
      : facts.rooms.length
        ? `${count(facts.rooms.length, "shared room keeps", "shared rooms keep")} your own tools to yourself.`
        : "No room is shared with anyone.",
    why: "Every call a guest's message leads to still waits for your yes, but a yes given in a hurry acts with your accounts and your machine.",
    ...(opened.length
      ? { items: opened.map((room) => ({ id: room.id, name: room.name, detail: room.ownerTools.join(", ") })), fix: { kind: "rooms", label: "Open room" } as Fix }
      : {}),
  });

  const reaching = facts.agents.filter((a) => a.browser || a.thisMachine);
  findings.push({
    id: "browser-computer",
    title: "Browsers and computer control",
    level: reaching.length ? "look" : "ok",
    summary: reaching.length
      ? `${names(reaching.map((a) => a.name))} ${reaching.length === 1 ? "has" : "have"} a browser or may use ${here}.`
      : `No agent has a browser of its own or the use of ${here}.`,
    why: `A browser acts on every site it is signed in to, and the use of ${here} means clicking and typing anywhere you can.`,
    ...(reaching.length
      ? {
          items: reaching.map((a) => ({
            id: a.id,
            name: a.name,
            detail: [a.browser && "a browser", a.thisMachine && here].filter(Boolean).join(" and "),
          })),
          fix: { kind: "agents", label: "Open settings" } as Fix,
        }
      : {}),
  });

  findings.push({
    id: "secrets",
    title: "Saved secrets",
    level: facts.secrets.length ? "look" : "ok",
    summary: facts.secrets.length
      ? `${count(facts.secrets.length, "secret is", "secrets are")} saved for your agents.`
      : "No secrets are saved.",
    why: "Every agent's commands can read a saved secret from their environment, on any turn you or something you set up starts.",
    ...(facts.secrets.length
      ? { items: facts.secrets.map((name) => ({ id: name, name })), fix: { kind: "secrets", label: "Forget" } as Fix }
      : {}),
  });

  if (facts.files) {
    const open = facts.files.filter((f) => f.open);
    findings.push({
      id: "files",
      title: "Files on disk",
      level: open.length ? "risky" : "ok",
      summary: open.length
        ? `${names(open.map((f) => f.name))} ${open.length === 1 ? "is" : "are"} open to other accounts on ${here}.`
        : "~/.bloks and the key files in it are private to your account.",
      why: "These hold your keys, saved secrets and agents' signing keys, so only your own account should be able to read them.",
      ...(open.length
        ? {
            items: open.map((f) => ({ id: f.path, name: f.name, detail: `${f.mode}, should be ${f.want}` })),
            fix: { kind: "permissions", label: "Fix permissions" } as Fix,
          }
        : {}),
    });
  }

  findings.push({
    id: "webhooks",
    title: "Webhooks",
    level: facts.webhooks ? "look" : "ok",
    summary: facts.webhooks ? `${count(facts.webhooks, "webhook is", "webhooks are")} on.` : "No webhook is on.",
    why: "Anyone holding a webhook's address can start a turn with it, so each one should still be needed.",
    ...(facts.webhooks ? { fix: { kind: "automations", tab: "webhooks", label: "Review webhooks" } as Fix } : {}),
  });

  const out = facts.signedOut;
  findings.push({
    id: "engines",
    title: "Engines",
    level: out.length ? "look" : "ok",
    summary: out.length
      ? `${names(out.map((e) => e.name))} ${out.length === 1 ? "is" : "are"} signed out.`
      : "No engine your agents use is signed out.",
    why: "An agent whose engine is signed out cannot answer, so work sent to it waits or fails, and a backup engine may answer instead.",
    ...(out.length
      ? {
          items: out.map((e) => ({ id: e.id, name: e.name, detail: `used by ${count(e.agents, "agent")}` })),
          fix: { kind: "page", page: "engines", label: "Sign in" } as Fix,
        }
      : {}),
  });

  if (facts.backups) {
    const on = facts.backups.auto;
    findings.push({
      id: "backups",
      title: "Automatic backups",
      level: on ? "ok" : "look",
      summary: on ? "Bloks backs up this workspace every day." : "Automatic backups are off.",
      why: "Without a recent backup, a failed disk or a folder deleted by mistake takes every agent, conversation and setting with it.",
      ...(on ? {} : { fix: { kind: "page", page: "backups", label: "Turn on backups" } as Fix }),
    });
  }

  return findings.sort((a, b) => ORDER[a.level] - ORDER[b.level]);
}

/** The data folder, the folder of agents' signing keys, and the files
 * that hold a credential: keys, saved secrets, webhook addresses, pairing
 * links, the people let into shared rooms. Transcripts are inside the
 * folder, which is enough to keep them private. */
const KEY_FILES = ["config.json", "webhooks.json", "pair-links.json", "people.json"];

/**
 * What each of those is, mode and all. A folder or file that is not there
 * is left out. Inside the folder, a link is left out too: changing its
 * mode would change whatever it points at, which may not be Bloks' at all.
 * The folder itself is followed, since a ~/.bloks moved to another disk
 * and linked back is still the data folder.
 */
export function filePermissions(dataDir: string, label = "~/.bloks"): FileCheck[] {
  const checks: FileCheck[] = [];
  const look = (path: string, name: string, want: FileCheck["want"], follow: boolean) => {
    try {
      const info = follow ? statSync(path) : lstatSync(path);
      if (info.isSymbolicLink() || (want === "0700" ? !info.isDirectory() : !info.isFile())) return;
      const mode = info.mode & 0o777;
      checks.push({ name, path, mode: `0${mode.toString(8).padStart(3, "0")}`, want, open: (mode & 0o077) !== 0 });
    } catch {
      /* not there */
    }
  };
  look(dataDir, label, "0700", true);
  for (const file of KEY_FILES) look(join(dataDir, file), `${label}/${file}`, "0600", false);
  const identities = join(dataDir, "identities");
  look(identities, `${label}/identities`, "0700", false);
  if (existsSync(identities)) {
    let keys: string[] = [];
    try {
      keys = readdirSync(identities).filter((name) => name.endsWith(".pem"));
    } catch {
      /* unreadable: the folder's own mode is what says so */
    }
    // one finding, however many agents: a workspace can have hundreds
    for (const key of keys.slice(0, 500)) look(join(identities, key), `${label}/identities/${key}`, "0600", false);
  }
  return checks;
}

/** Takes every open one back to what it should be. Returns what changed,
 * and what could not be changed (a file owned by another account). */
export function tightenPermissions(dataDir: string, label?: string): { fixed: string[]; failed: string[] } {
  const fixed: string[] = [];
  const failed: string[] = [];
  for (const check of filePermissions(dataDir, label)) {
    if (!check.open) continue;
    try {
      chmodSync(check.path, parseInt(check.want, 8));
      fixed.push(check.name);
    } catch {
      failed.push(check.name);
    }
  }
  return { fixed, failed };
}
