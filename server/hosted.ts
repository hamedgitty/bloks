// Hosted mode: a workspace running on a machine somebody runs for the
// person, rather than on the person's own Mac.
//
// Everything about Bloks works the same there except what is about the
// machine. On a Mac the agents borrow the person's computer, or rent one
// (the cloud box), or build one beside it (the Local VM). On a hosted
// machine the machine is the agents' computer already: its browser and
// its virtual desktop are theirs, so the other two are not offered, and
// the API refuses them rather than set up a computer inside a computer.
// What only a Mac can do (working the person's own Mac, the Mac's
// voices, listening to a meeting through its microphone) is said plainly
// instead of failing somewhere further down.
//
// The virtual desktop is shown through noVNC, which the hosting image
// serves on loopback. It is reached through this server, never a new
// public port: a short lived ticket, minted for the person, names the way
// in, because the viewer is a page in a frame and cannot send the
// person's token with each request the way the app does.
//
// Read once, at startup: a workspace does not become hosted while it runs.
import { randomBytes } from "node:crypto";

/** BLOKS_HOSTED=1 turns hosted mode on. Anything else leaves it off. */
export function isHosted(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BLOKS_HOSTED === "1";
}

/** What a feature that needs the person's own Mac says on a hosted
 * workspace. */
export const NEEDS_MAC = "This needs Bloks running on a Mac.";

export type ComputerMode = "cloud" | "sandbox" | "local" | "off";
const MODES: readonly ComputerMode[] = ["cloud", "sandbox", "local", "off"];

/** Whether an agent can work the screen of the computer Bloks runs on.
 * That goes through cua-driver, which Bloks ships and starts only on a
 * Mac (electron/cua.mjs), so anywhere else "This computer" would be a
 * choice that quietly gives the agent nothing (GitHub 377). */
export function ownScreenWorks(platform: string = process.platform): boolean {
  return platform === "darwin";
}

/** Where an agent may act, as a settings screen offers it. On a hosted
 * workspace "local" is this machine: its browser and its virtual
 * desktop. Off a Mac this computer's own screen is not offered, since
 * nothing here can work it; the Local VM and the cloud box still are. */
export function computerChoices(hosted: boolean, platform: string = process.platform): Array<{ id: ComputerMode; label: string }> {
  if (hosted) {
    return [
      { id: "local", label: "This machine" },
      { id: "off", label: "Off" },
    ];
  }
  return [
    { id: "cloud", label: "Cloud box" },
    { id: "sandbox", label: "Local VM" },
    ...(ownScreenWorks(platform) ? [{ id: "local" as const, label: "This computer" }] : []),
    { id: "off", label: "Off" },
  ];
}

/** What working this computer's own screen needs, said where it is
 * asked for off a Mac. */
export const OWN_SCREEN_NEEDS_MAC =
  "Agents can work this computer's own screen only when Bloks runs on a Mac. Choose the Local VM or a cloud box instead.";

/** Why an agent's computer cannot be set to `value`, or null when it can.
 * Null is automatic and is always allowed. On a Mac nothing is refused
 * here, as before hosted mode existed: what a phone already sends keeps
 * working. Elsewhere this computer's own screen is refused, since nothing
 * could work it. A hosted workspace holds the value to what it offers. */
export function computerRefusal(value: unknown, hosted: boolean, platform: string = process.platform): string | null {
  if (value === null) return null;
  if (!hosted) return value === "local" && !ownScreenWorks(platform) ? OWN_SCREEN_NEEDS_MAC : null;
  if (typeof value !== "string" || !MODES.includes(value as ComputerMode)) {
    return "computer is local, off or null on a hosted workspace";
  }
  if (value === "cloud" || value === "sandbox") {
    return "This workspace is hosted, so it is the agents' computer already: its browser and its virtual desktop. The cloud box and the Local VM are not offered here.";
  }
  return null;
}

/** Why a turn has no computer: the agent's own setting is off, the turn
 * is someone else's and the owner's computer is not lent to it, or
 * nothing the agent could be given was there. */
export type NoComputer = "off" | "withheld" | "none";

/** What an agent with no computer is told about it. Told nothing, an
 * agent asked "can you see the Local VM?" could only answer that there
 * is no computer, and the person was left to guess why (GitHub 377). So
 * it is told what it could have and where the person gives it. */
export function noComputerLine(why: NoComputer, o: { hosted: boolean; platform?: string }): string {
  if (why === "withheld") {
    return " You have no computer on this turn: your owner did not start it, so their computer is not lent to it.";
  }
  const off = why === "off" ? "You have no computer: it is switched off in your settings." : "You have no computer on this turn.";
  // a hosted machine is always the computer unless the setting is off
  if (o.hosted) return why === "off" ? ` ${off} If a task needs one, say so; the person can switch it on there, under Computer.` : "";
  const platform = o.platform ?? process.platform;
  const choices = ownScreenWorks(platform)
    ? "This computer (their own Mac, once Bloks has macOS's Accessibility and Screen Recording permissions), Local VM (a free Linux desktop in a container here, set up in Settings, under Local VM), or Cloud box"
    : `Local VM (a free Linux desktop in a container here, set up in Settings, under Local VM) or Cloud box. Working their own ${platform === "win32" ? "Windows PC" : "computer"}'s screen needs Bloks running on a Mac, so it is not offered here`;
  return ` ${off} If a task needs one, or you are asked whether you can see a computer, say so plainly and how to give you one: in your settings, under Computer, the person picks ${choices}.`;
}

const NOT_HERE = "This workspace is hosted, so it is the agents' computer already: its browser and its virtual desktop.";

/** What the API refuses on a hosted workspace, before any route runs: the
 * cloud box and the Local VM, which would be a computer inside the
 * computer, and meeting notes, which listen through the person's own Mac.
 * Null for everything else. */
export function hostedRefusal(method: string, path: string): { status: number; error: string } | null {
  if (path === "/api/local-vm" || path.startsWith("/api/local-vm/")) {
    return { status: 409, error: `${NOT_HERE} The Local VM is not offered here.` };
  }
  if (path === "/api/box/settings" || /^\/api\/bots\/[\w-]+\/computer(?:\/[\w-]+)?$/.test(path)) {
    return { status: 409, error: `${NOT_HERE} The cloud box is not offered here.` };
  }
  if (method === "POST" && path === "/api/meetings") {
    return { status: 409, error: `Meeting notes listen through your Mac's microphone. ${NEEDS_MAC}` };
  }
  // Where the person is goes only to a computer of their own, never to a
  // machine run for them (server/location.ts), so the phone never offers
  // it here and nothing here takes it or tells it.
  if (path === "/api/location" || path === "/api/agent/location") {
    return { status: 409, error: "This workspace is hosted. Location from your iPhone goes only to a computer of your own, so it is not offered here." };
  }
  return null;
}

/** The computer a turn uses on a hosted workspace. Anything stored for a
 * Mac (a workspace moved here, a routine's own choice) becomes this
 * machine, which is the nearest thing to what was meant; off stays off. */
export function hostedComputer(wants: ComputerMode | null | undefined): "local" | "off" | null {
  if (wants === "off") return "off";
  return wants ? "local" : null;
}

/** Where the virtual desktop's viewer listens, from BLOKS_HOSTED_VNC: a
 * port, host:port, or an http URL with a path, always on loopback. A
 * value that names anywhere else is refused, since this server would
 * otherwise become a way to reach it. */
export interface VncTarget {
  host: string;
  port: number;
  /** The path the viewer is served under, ending in a slash. */
  prefix: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function vncTarget(raw: string | undefined): VncTarget | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const port = (text: string) => {
    const n = Number(text);
    return Number.isInteger(n) && n > 0 && n < 65_536 ? n : null;
  };
  if (/^\d+$/.test(value)) {
    const p = port(value);
    return p ? { host: "127.0.0.1", port: p, prefix: "/" } : null;
  }
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `http://${value}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || url.username || url.password) return null;
  if (!LOOPBACK.has(url.hostname)) return null;
  const p = port(url.port || "80");
  if (!p) return null;
  const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname.replace(/^\[|\]$/g, "");
  let prefix = url.pathname || "/";
  // a path to the page itself names its folder
  if (/\.html?$/i.test(prefix)) prefix = prefix.slice(0, prefix.lastIndexOf("/") + 1);
  if (!prefix.endsWith("/")) prefix += "/";
  return { host, port: p, prefix };
}

/** The path the viewer is reached under, on this server. */
export const DESKTOP_PATH = "/hosted/desktop/";

/** How long a ticket opens new requests after it was last used. An open
 * desktop keeps its connection however long it is watched. */
export const TICKET_IDLE_MS = 10 * 60_000;
/** And never longer than this from when it was minted. */
export const TICKET_LIFE_MS = 12 * 60 * 60_000;

/** Tickets to the virtual desktop. In memory: a restart ends them, and
 * the panel mints another when it opens. */
export class DesktopTickets {
  private readonly tickets = new Map<string, { minted: number; used: number }>();

  mint(now = Date.now()): string {
    this.sweep(now);
    const id = randomBytes(24).toString("hex");
    this.tickets.set(id, { minted: now, used: now });
    // a handful at most: each open panel holds one
    while (this.tickets.size > 32) this.tickets.delete(this.tickets.keys().next().value!);
    return id;
  }

  /** Whether the ticket still opens requests, renewing its idle time. */
  use(id: string, now = Date.now()): boolean {
    const ticket = this.tickets.get(id);
    if (!ticket) return false;
    if (now - ticket.used > TICKET_IDLE_MS || now - ticket.minted > TICKET_LIFE_MS) {
      this.tickets.delete(id);
      return false;
    }
    ticket.used = now;
    return true;
  }

  private sweep(now: number) {
    for (const [id, ticket] of this.tickets) {
      if (now - ticket.used > TICKET_IDLE_MS || now - ticket.minted > TICKET_LIFE_MS) this.tickets.delete(id);
    }
  }
}

/** A request path under DESKTOP_PATH, split into its ticket and the rest,
 * or null. The rest never climbs out of the viewer's folder. */
export function desktopRequest(path: string): { ticket: string; rest: string } | null {
  if (!path.startsWith(DESKTOP_PATH)) return null;
  const tail = path.slice(DESKTOP_PATH.length);
  const slash = tail.indexOf("/");
  const ticket = slash === -1 ? tail : tail.slice(0, slash);
  if (!/^[0-9a-f]{48}$/.test(ticket)) return null;
  const rest = slash === -1 ? "" : tail.slice(slash + 1);
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return null;
  }
  if (decoded.split("/").some((part) => part === ".." || part === ".") || decoded.includes("\\")) return null;
  return { ticket, rest };
}

/**
 * Where this machine answers from outside, from BLOKS_PUBLIC_URL, when it
 * has a door of its own: a hosted machine's one public port, which passes
 * the viewer's ticketed paths (and nothing else) on to this server. An
 * https origin and nothing more, or http on loopback for a test. The app
 * reached through Bloks Cloud, which carries requests and their answers
 * but not a live desktop, opens the viewer there instead, under the same
 * ticket; without one, the desktop is shown only where this server is
 * reached directly.
 */
export function publicDoor(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  const loopback = url.protocol === "http:" && LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !loopback) return null;
  return url.origin;
}

/** The page that opens the viewer through a ticket: noVNC's own page,
 * told to connect at once, scale to the frame, and find its socket under
 * the same ticket. */
export function viewerUrl(ticket: string): string {
  const base = `${DESKTOP_PATH}${ticket}/`;
  const socket = `${base.slice(1)}websockify`;
  return `${base}vnc.html?autoconnect=true&resize=scale&reconnect=true&path=${encodeURIComponent(socket)}`;
}

/** Headers that belong to one hop and are never passed along. */
export const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
