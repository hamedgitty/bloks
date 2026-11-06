// A server of your own, reached your own way.
//
// bloks-server was built to be reached through Bloks Cloud alone: it
// listens on loopback and connects out, so no port is opened. That is
// still what it does unless told otherwise. Some people would rather it
// did not depend on anything of ours at all: they run it at home or on a
// rented box, behind a reverse proxy, a tunnel or a VPN they already
// trust, and their devices should reach it there, with Bloks Cloud never
// asked for anything. Three settings, read where it runs, say so:
//
//   BLOKS_LISTEN      0.0.0.0 or ::, for bloks-server to listen beyond
//                     loopback: in a container (the image sets it, and
//                     the published port decides who reaches it), or on
//                     a machine whose own firewall or VPN does.
//   BLOKS_PUBLIC_URL  where the owner's devices reach it: an https address
//                     behind their reverse proxy or tunnel, or an http one
//                     on their VPN or home network. Pairing hands a device
//                     this address and a one time code, and the device
//                     talks to it directly from then on, with its own
//                     token, exactly as a phone on the same wifi does.
//   BLOKS_CLOUD=off   nothing goes to Bloks Cloud or bloks.dev: no relay
//                     line, no activation, no plan lookups, no galleries,
//                     no Bloks AI. A licence already on this machine is
//                     kept and simply not used.
//
// None of these can be set from a paired device, for the reason the
// terminal setting cannot (server/deployment.ts): a device that could
// widen its own way in would not need to be trusted with one. And none of
// them moves the boundary: a request that does not arrive on loopback
// from this machine itself needs a paired device's token, wherever it
// came from (server/http-guard.ts).
//
// Read once, at startup, like the rest of the machine's kind.
import { isHosted } from "./hosted.ts";
import { normalizeCompatUrl } from "./providers.ts";

/** Off, in any of the ways a person writes off in an .env file. */
export function cloudOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(off|0|false|no)$/i.test((env.BLOKS_CLOUD ?? "").trim());
}

/** Whether this process is a bloks-server, which never decides where it
 * listens from the pairing switch (bin/bloks-server.mjs sets it). */
export function headless(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BLOKS_LOOPBACK_ONLY === "1";
}

/**
 * The address BLOKS_LISTEN names, or null for loopback: every IPv4
 * interface (0.0.0.0) or every interface (::), and nothing narrower. One
 * address of a VPN would leave loopback unheard, and loopback is where
 * `bloks-server pair`, `status` and a container's health check talk to
 * it; narrowing is the published port's job in a container, and on a
 * bare machine a VPN's own proxy (`tailscale serve`) or a reverse proxy
 * reaches loopback without this at all. Anything else is null, so a typo
 * keeps the server on loopback rather than opening it somewhere nobody
 * meant, and `listenProblem` says so on the start line.
 */
export function listenAddress(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.BLOKS_LISTEN ?? "").trim().replace(/^\[(.*)\]$/, "$1");
  return raw === "0.0.0.0" || raw === "::" ? raw : null;
}

/** Why BLOKS_LISTEN was not used, or null when it was or was not set. */
export function listenProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.BLOKS_LISTEN ?? "").trim();
  if (!raw || listenAddress(env) || ["127.0.0.1", "localhost", "::1", "[::1]"].includes(raw)) return null;
  return `BLOKS_LISTEN=${raw} is not 0.0.0.0 or ::, so Bloks listens on loopback only`;
}

/** As many as a person would reasonably give: a public name, a VPN
 * address, a home network address. */
const MAX_PUBLIC_URLS = 4;

/**
 * The addresses BLOKS_PUBLIC_URL gives, each an origin: http or https, a
 * host and a port, no path, no query, no credentials. Separated by commas
 * or spaces. A path is refused rather than kept, since the app calls the
 * server at /api from the root and a proxy that serves Bloks under
 * /bloks/ would answer none of it. Duplicates go; what cannot be read is
 * dropped and said by `publicUrlProblems`.
 */
export function publicUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  return readPublicUrls(env).urls;
}

/** What in BLOKS_PUBLIC_URL was not used, and why, for the start line. */
export function publicUrlProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  return readPublicUrls(env).problems;
}

function readPublicUrls(env: NodeJS.ProcessEnv): { urls: string[]; problems: string[] } {
  const urls: string[] = [];
  const problems: string[] = [];
  for (const part of (env.BLOKS_PUBLIC_URL ?? "").split(/[\s,]+/).filter(Boolean)) {
    let url: URL;
    try {
      url = new URL(part);
    } catch {
      problems.push(`${part} is not an address`);
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") problems.push(`${part} is not http or https`);
    else if (url.username || url.password) problems.push(`${part} carries a name or password`);
    else if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) problems.push(`${part} has a path; Bloks has to be served from the root of its address`);
    else if (urls.length >= MAX_PUBLIC_URLS) problems.push(`${part} is past the first ${MAX_PUBLIC_URLS}`);
    else if (!urls.includes(url.origin)) urls.push(url.origin);
  }
  return { urls, problems };
}

/**
 * Whether this bloks-server is reached directly, at an address of the
 * owner's own, rather than through Bloks Cloud alone: it listens beyond
 * loopback, or a reverse proxy on this machine sends it the owner's
 * devices (BLOKS_PUBLIC_URL). Never on a managed hosting machine, whose
 * BLOKS_PUBLIC_URL is the provider's door for the virtual desktop
 * (server/hosted.ts publicDoor) and no way in for a device.
 */
export function directDoor(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!headless(env) || isHosted(env)) return false;
  return Boolean(listenAddress(env)) || publicUrls(env).length > 0;
}

/** What /api/config says of how this server is reached, for Settings and
 * for the docs to point at: the addresses the owner gave, and whether
 * Bloks Cloud is turned off where it runs. No secret is in it. */
export function reachView(env: NodeJS.ProcessEnv = process.env) {
  return {
    cloud: cloudOff(env) ? ("off" as const) : ("on" as const),
    direct: directDoor(env),
    publicUrls: directDoor(env) ? publicUrls(env) : [],
  };
}

/** A model server named where Bloks runs, as an engine. */
export interface EnvModelEndpoint {
  url: string;
  /** What the server takes as its key; "none" stands in for a server
   * that asks for none, since every OpenAI-compatible client sends one. */
  key: string;
  name: string;
  tools: boolean;
  vision: boolean;
  /** Its model takes a reasoning effort (BLOKS_MODEL_EFFORT=1). */
  effort: boolean;
}

/** The engine id a model server from the environment goes by. Never one
 * Settings makes, whose ids are random. */
export const ENV_MODEL_ENDPOINT_ID = "env";

/**
 * An OpenAI-compatible model server given in the environment (a vLLM, a
 * llama.cpp server, LM Studio, LiteLLM, a self-hosted Qwen), so a server
 * in a container comes up with its model engine already there and no
 * Settings screen to visit:
 *
 *   BLOKS_MODEL_URL     its /v1 root, http or https
 *   BLOKS_MODEL_KEY     its key; empty for a server that takes none
 *   BLOKS_MODEL_NAME    what the engine is called in the app
 *   BLOKS_MODEL_TOOLS=1 its model calls tools (only its owner knows)
 *   BLOKS_MODEL_VISION=1  its model sees pictures
 *   BLOKS_MODEL_EFFORT=1  its model takes a reasoning effort
 *
 * The same engine an endpoint added in Settings, Engines makes, read from
 * here each start and never written to config.json, so the key stays
 * where it was put. Null when no usable URL is given.
 */
export function envModelEndpoint(env: NodeJS.ProcessEnv = process.env): EnvModelEndpoint | null {
  const url = normalizeCompatUrl(env.BLOKS_MODEL_URL ?? "");
  if (!url) return null;
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  return {
    url,
    key: (env.BLOKS_MODEL_KEY ?? "").trim() || "none",
    name: (env.BLOKS_MODEL_NAME ?? "").trim().slice(0, 60) || host,
    tools: env.BLOKS_MODEL_TOOLS === "1",
    vision: env.BLOKS_MODEL_VISION === "1",
    effort: env.BLOKS_MODEL_EFFORT === "1",
  };
}

/** Said in place of anything that would have gone to Bloks Cloud. */
export const CLOUD_OFF =
  "Bloks Cloud is turned off on this server (BLOKS_CLOUD=off where it runs), so nothing is sent to it. Pair your devices at the server's own address instead.";

/**
 * The link a device opens to pair with this server at one of its
 * addresses, carrying the one time token and the six digit code beside
 * it (server/pairing.ts startPairing). An http address with a port is
 * written the way a Mac's pairing code has always been written
 * (address=host:port), which the iPhone app and the desktop app both
 * read; an https address is written whole (url=), which the desktop app
 * reads. Null for anything that fails its shape, so nothing malformed
 * reaches a camera.
 */
export function directPairLink(origin: string, token: string, code: string, name?: string): string | null {
  if (!/^\d{6}$/.test(code)) return null;
  if (!/^bloks_pair_[A-Za-z0-9_-]{32}$/.test(token)) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
  const named = name?.trim() ? `&name=${encodeURIComponent(name.trim().slice(0, 60))}` : "";
  if (url.protocol === "http:") {
    const port = url.port || "80";
    return `bloks://pair?address=${encodeURIComponent(`${url.hostname}:${port}`)}&token=${token}&code=${code}${named}`;
  }
  return `bloks://pair?url=${encodeURIComponent(url.origin)}&token=${token}&code=${code}${named}`;
}
