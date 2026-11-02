// Agents get voices.
//
// One interface, several vendors: ElevenLabs, OpenAI's speech API, Fish
// Audio and xAI each when their key is present (xAI's falls back to the
// Grok engine's, the same account), a Chatterbox server the person runs
// on their own machine or network, and on a Mac the voices macOS ships
// with, which need no key and no account, so every agent can talk from
// the first day. The harness holds the keys and streams the audio
// through; a client never touches a vendor directly. Voices are listed
// live from vendors that have a catalog and from a fixed set where the
// vendor ships one, merged into a single picker.
//
// Text is capped before it becomes sound: TTS is billed per character,
// and a runaway reply should cost a sentence, not a chapter.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { AppConfig } from "./config.ts";
import { isHosted } from "./hosted.ts";

export const VOICE_PROVIDERS = ["elevenlabs", "openai", "fish", "xai", "chatterbox", "system"] as const;
export type VoiceProvider = (typeof VOICE_PROVIDERS)[number];

export interface Voice {
  provider: VoiceProvider;
  id: string;
  name: string;
}

export interface BotVoice {
  provider: VoiceProvider;
  id: string;
  name?: string;
}

/** How long a hosted vendor's voice list may take. The picker waits on
 * the slowest, and one vendor being down must not hold up the rest. */
const LIST_TIMEOUT_MS = 10_000;

/** The hosted vendors' roots. Overridden only so a test can stand a fake
 * in their place; nothing in the app sets them. */
const fishBase = () => (process.env.BLOKS_FISH_AUDIO_URL?.trim() || "https://api.fish.audio").replace(/\/+$/, "");
const xaiBase = () => (process.env.BLOKS_XAI_SPEECH_URL?.trim() || "https://api.x.ai").replace(/\/+$/, "");
const elevenlabsBase = () => (process.env.BLOKS_ELEVENLABS_URL?.trim() || "https://api.elevenlabs.io").replace(/\/+$/, "");
const openaiBase = () => (process.env.BLOKS_OPENAI_SPEECH_URL?.trim() || "https://api.openai.com").replace(/\/+$/, "");

export const SPEAK_MAX_CHARS = 2_500;

/** OpenAI ships a fixed cast; no listing round-trip needed. */
const OPENAI_VOICES = [
  "alloy",
  "ash",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
].map((id) => ({
  provider: "openai" as const,
  id,
  name: id[0].toUpperCase() + id.slice(1),
}));

/** xAI's built-in voices, for when its list cannot be read: the five its
 * documentation names, with eve its default. */
const XAI_VOICES = ["eve", "ara", "leo", "rex", "sal"].map((id) => ({
  provider: "xai" as const,
  id,
  name: id[0].toUpperCase() + id.slice(1),
}));

/** A Chatterbox server always has its own default voice, asked for by
 * sending none; anything else is what its voices folder holds. */
const CHATTERBOX_DEFAULT: Voice = { provider: "chatterbox", id: "default", name: "Default" };

/** Fish Audio voices from one page of its model list. */
export function parseFishModels(body: any): Voice[] {
  const voices: Voice[] = [];
  for (const item of Array.isArray(body?.items) ? body.items : []) {
    if (typeof item?._id !== "string" || !item._id || typeof item?.title !== "string") continue;
    // the list also holds voice-conversion models, which cannot speak text
    if (item.type !== undefined && item.type !== "tts") continue;
    voices.push({ provider: "fish", id: item._id, name: item.title.trim().slice(0, 80) || item._id });
  }
  return voices;
}

/** The person's own Fish voices first (clones they made), then the most
 * used public ones, without repeats. */
async function fishVoices(key: string): Promise<Voice[]> {
  const page = async (query: string) => {
    try {
      const res = await fetch(`${fishBase()}/model?${query}`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      });
      return res.ok ? parseFishModels(await res.json()) : [];
    } catch {
      return [];
    }
  };
  const [own, popular] = await Promise.all([page("self=true&page_size=100"), page("sort_by=score&page_size=24")]);
  const seen = new Set<string>();
  return [...own, ...popular].filter((v) => !seen.has(v.id) && seen.add(v.id));
}

/** xAI's voices from GET /v1/tts/voices, or its documented five when the
 * list cannot be read. */
async function xaiVoices(key: string): Promise<Voice[]> {
  try {
    const res = await fetch(`${xaiBase()}/v1/tts/voices`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    if (res.ok) {
      const body: any = await res.json();
      const voices = (Array.isArray(body?.voices) ? body.voices : [])
        .filter((v: any) => typeof v?.voice_id === "string" && v.voice_id)
        .map((v: any) => ({
          provider: "xai" as const,
          id: v.voice_id,
          name: `${typeof v.name === "string" && v.name ? v.name : v.voice_id}${typeof v.language === "string" && v.language ? ` (${v.language})` : ""}`,
        }));
      if (voices.length) return voices;
    }
  } catch {
    /* the fixed five below */
  }
  return XAI_VOICES;
}

/**
 * A Chatterbox server's voices, in whichever shape it lists them: the
 * servers people run differ (a bare array, { voices }, { data }, names or
 * objects naming a file). The id is what the server is sent back.
 */
export function parseChatterboxVoices(body: any): Voice[] {
  const list = Array.isArray(body) ? body : Array.isArray(body?.voices) ? body.voices : Array.isArray(body?.data) ? body.data : [];
  const voices: Voice[] = [];
  for (const item of list) {
    const id =
      typeof item === "string"
        ? item
        : [item?.filename, item?.voice_id, item?.id, item?.name].find((v): v is string => typeof v === "string" && v.length > 0);
    if (!id || id.length > 120) continue;
    const label = typeof item === "object" && typeof item?.display_name === "string" && item.display_name ? item.display_name : typeof item === "object" && typeof item?.name === "string" && item.name ? item.name : id;
    voices.push({ provider: "chatterbox", id, name: label.replace(/\.(wav|mp3|flac|ogg)$/i, "").slice(0, 80) });
  }
  return voices;
}

/** The voices list routes the Chatterbox servers in use answer on. */
const CHATTERBOX_LISTS = ["/v1/audio/voices", "/voices", "/get_predefined_voices"];

async function chatterboxVoices(url: string): Promise<Voice[]> {
  for (const route of CHATTERBOX_LISTS) {
    let res: Response;
    try {
      res = await fetch(`${url}${route}`, { signal: AbortSignal.timeout(4_000) });
    } catch {
      // Not up. It still offers its default, and speaking says what is
      // wrong; asking the next route would only make the picker wait.
      break;
    }
    if (!res.ok) continue;
    const voices = parseChatterboxVoices(await res.json().catch(() => null));
    if (voices.length) return [CHATTERBOX_DEFAULT, ...voices.filter((v) => v.id !== CHATTERBOX_DEFAULT.id)];
  }
  return [CHATTERBOX_DEFAULT];
}

/** An OpenAI key that already exists on this machine. The ChatGPT OAuth
 * Codex signs in with cannot call the speech API, but Codex's auth file
 * carries a real API key when the user linked one, and the environment
 * may too, either saves the user a paste. */
function discoveredOpenAIKey(): { key: string; source: "env" | "codex" } | null {
  if (process.env.OPENAI_API_KEY) return { key: process.env.OPENAI_API_KEY, source: "env" };
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".codex", "auth.json"), "utf8"));
    if (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY) {
      return { key: auth.OPENAI_API_KEY, source: "codex" };
    }
  } catch {}
  return null;
}

function openaiKey(cfg: AppConfig): string | undefined {
  if (cfg.speech?.openaiKey) return cfg.speech.openaiKey;
  // a key found elsewhere is used only with explicit consent: it bills
  // an account the user set up for something else, and surprises about
  // money are the worst kind
  if (cfg.speech?.useDiscoveredOpenAI) return discoveredOpenAIKey()?.key;
  return undefined;
}

/** xAI's voice key: one saved for speech, else the Grok engine's. Unlike
 * a key found lying around, the Grok key was given to Bloks already, for
 * the same account, so using it needs no second yes; Settings says which
 * one speaks. */
export function xaiKey(cfg: AppConfig): { key: string; source: "speech" | "grok" } | null {
  if (cfg.speech?.xaiKey) return { key: cfg.speech.xaiKey, source: "speech" };
  const grok = cfg.providers?.grok?.key || cfg.xai?.key;
  return grok ? { key: grok, source: "grok" } : null;
}

// ── a Chatterbox server of the person's own ───────────────────────────

/** Names that only mean something on this computer or a home network.
 * A bare name with no dot ("studio") is one too: the internet has none. */
const LOCAL_NAMES = /(?:^localhost$|\.localhost$|\.local$|\.lan$|\.home$|\.home\.arpa$|\.internal$|\.ts\.net$|^[a-z0-9-]+$)/i;

/** Whether a host is this computer or on its network: loopback, a private
 * or link-local address (IPv4 or IPv6), Tailscale's range, or a name only
 * a local network resolves. */
export function isLocalHost(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = name.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (name.includes(":")) return name === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(name) || /^fe[89ab][0-9a-f]?:/.test(name);
  return LOCAL_NAMES.test(name);
}

/** Each server of the person's own: its name, an address it usually has,
 * and the endpoint path a pasted address is folded back from. */
const LOCAL_SERVERS = {
  chatterbox: { name: "Chatterbox", example: "http://localhost:4123", endpoint: /\/v1(?:\/audio(?:\/speech)?)?$/i },
  whisper: { name: "Whisper", example: "http://localhost:8000", endpoint: /\/v1(?:\/audio(?:\/transcriptions)?)?$/i },
} as const;

/**
 * The address of a server of the person's own they meant, or why it
 * cannot be one. A pasted endpoint path is folded back to the server's
 * root. It has to be on this computer or its network: every reply read
 * aloud goes to Chatterbox as text, and what you say goes to Whisper as
 * sound, both with no key, and a server out on the internet is not the
 * "my own machine" these rows promise.
 */
function localServerUrl(raw: unknown, kind: keyof typeof LOCAL_SERVERS): { url: string } | { error: string } {
  const { name, example, endpoint } = LOCAL_SERVERS[kind];
  const said = typeof raw === "string" ? raw.trim() : "";
  if (!said) return { error: `Give the address of the ${name} server, like ${example}.` };
  if (said.length > 400) return { error: "That address is too long." };
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(said) ? said : `http://${said}`);
  } catch {
    return { error: `That is not an address. Try ${example}.` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { error: "The address must start with http:// or https://." };
  if (parsed.username || parsed.password) return { error: `Leave the name and password out of the address: ${name} takes no sign-in.` };
  if (!isLocalHost(parsed.hostname)) {
    return {
      error: `${name} has to run on this computer or your own network: use localhost, a .local name, or a private address like 192.168.1.20.`,
    };
  }
  const path = parsed.pathname.replace(/\/+$/, "").replace(endpoint, "");
  return { url: `${parsed.protocol}//${parsed.host}${path}` };
}

/** The Chatterbox address a person meant, or why it cannot be one. */
export function normalizeChatterboxUrl(raw: unknown): { url: string } | { error: string } {
  return localServerUrl(raw, "chatterbox");
}

/** The Whisper server address a person meant, or why it cannot be one:
 * anything that answers OpenAI's /v1/audio/transcriptions, as the
 * Whisper servers people run (faster-whisper, whisper.cpp, LocalAI,
 * Speaches) all do. */
export function normalizeWhisperUrl(raw: unknown): { url: string } | { error: string } {
  return localServerUrl(raw, "whisper");
}

function chatterboxUrl(cfg: AppConfig): string | null {
  const saved = cfg.speech?.chatterboxUrl;
  if (!saved) return null;
  const checked = normalizeChatterboxUrl(saved);
  return "url" in checked ? checked.url : null;
}

function whisperUrl(cfg: AppConfig): string | null {
  const saved = cfg.speech?.whisperUrl;
  if (!saved) return null;
  const checked = normalizeWhisperUrl(saved);
  return "url" in checked ? checked.url : null;
}

// ── what went wrong, as the thing to fix ──────────────────────────────

const VENDOR_NAMES = { fish: "Fish Audio", xai: "xAI", chatterbox: "Chatterbox" } as const;
type SpokenVendor = keyof typeof VENDOR_NAMES;

/** The vendor's own sentence from an error body, short, when it gave one. */
function vendorSaid(body: string): string {
  const text = body.trim();
  try {
    const parsed = JSON.parse(text);
    const said = [parsed?.message, parsed?.error?.message, parsed?.error, parsed?.detail, parsed?.reason].find(
      (v): v is string => typeof v === "string" && v.trim().length > 0,
    );
    if (said) return said.trim().slice(0, 140);
  } catch {
    /* not JSON: the text itself, if it is short enough to be a sentence */
  }
  return text.length <= 140 && !/<[a-z!]/i.test(text) ? text : "";
}

/**
 * A refused speech request, said as what to do about it. `keyFrom` is
 * which xAI key was sent, since a refused Grok key is fixed in Engines,
 * not in Voices; `where` is the Chatterbox address that answered.
 */
export function speechError(
  vendor: SpokenVendor,
  status: number,
  body: string,
  context: { keyFrom?: "speech" | "grok"; where?: string } = {},
): string {
  const name = VENDOR_NAMES[vendor];
  const said = vendorSaid(body);
  const detail = said ? ` (${said})` : "";
  if (vendor === "chatterbox") {
    const at = context.where ?? "the Chatterbox address";
    if (status === 404 || status === 405) {
      return `${at} answered, but not as a Chatterbox server: it has no /v1/audio/speech. Check the address in Settings, Voices.`;
    }
    if (status === 400 || status === 422) return `Chatterbox could not use that voice or text${detail}. Pick another voice, or check the server's voices folder.`;
    if (status >= 500) return `Chatterbox failed to speak${detail}. Its own log says why.`;
    return `Chatterbox answered ${status}${detail}.`;
  }
  if (status === 401 || status === 403) {
    if (vendor === "xai" && context.keyFrom === "grok") {
      return "xAI did not accept the Grok key used for speech. Replace it in Settings, Engines, or add an xAI key for speech in Settings, Voices.";
    }
    return `${name} did not accept the key. Paste a new one in Settings, Voices.`;
  }
  if (status === 402 || /credit|balance|payment/i.test(said)) {
    return vendor === "fish"
      ? "Fish Audio says the account has no credit left. Add some at fish.audio, then try again."
      : "xAI says the team is out of credits. Add some at console.x.ai, then try again.";
  }
  if (status === 404) return `${name} has no voice by that ID any more. Pick another in the agent's voice settings.`;
  if (status === 429) return `${name} is limiting requests just now. Wait a moment and try again.`;
  if (status >= 500) return `${name} is not answering properly right now${detail}. Try again shortly.`;
  return `${name} refused to speak: ${status}${detail}.`;
}

/** Why a request to a Chatterbox server never got an answer at all. */
function chatterboxUnreachable(where: string, error: unknown): Error {
  const name = (error as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return new Error(`Chatterbox at ${where} took too long to answer. A first request can be slow while the model loads; try again.`);
  }
  return new Error(`Nothing answered at ${where}. Start the Chatterbox server, or check the address in Settings, Voices.`);
}

// ── the Mac's own voices ───────────────────────────────────────────────

/** The novelty voices macOS carries alongside the real ones. Offered to
 * nobody: an agent announcing a deploy in "Bubbles" is a joke once. */
const NOVELTY = new Set([
  "Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Good News", "Jester",
  "Organ", "Superstar", "Trinoids", "Whisper", "Wobble", "Zarvox", "Fred", "Junior", "Ralph", "Kathy",
]);

/** `say -v '?'` lines: "Samantha            en_US    # Hello! My name is Samantha." */
export function parseSayVoices(listing: string, languages = /^en_/): Voice[] {
  const voices: Voice[] = [];
  for (const line of listing.split("\n")) {
    const found = line.match(/^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]{2,4})\s+#/);
    if (!found) continue;
    const name = found[1].trim();
    if (!languages.test(found[2])) continue;
    if (NOVELTY.has(name) || NOVELTY.has(name.split(" (")[0])) continue;
    voices.push({ provider: "system", id: name, name: `${name} (${found[2].replace("_", "-")})` });
  }
  return voices;
}

let systemVoices: Promise<Voice[]> | null = null;

/** Whether the Mac's own voices are here: on a Mac, and not a hosted
 * workspace, whose machine is not the person's (server/hosted.ts). */
const MAC_VOICES = process.platform === "darwin" && !isHosted();

/** The Mac's voices, read once. Empty anywhere else. */
function macVoices(): Promise<Voice[]> {
  if (!MAC_VOICES) return Promise.resolve([]);
  systemVoices ??= new Promise((resolve) => {
    execFile("/usr/bin/say", ["-v", "?"], { timeout: 10_000 }, (error, stdout) =>
      resolve(error ? [] : parseSayVoices(String(stdout))),
    );
  });
  return systemVoices;
}

/** Speech from `say`, as AAC in an M4A container every player takes. The
 * text goes in on stdin, so a reply never appears in a process listing. */
function sayToStream(voice: string, text: string): Promise<ReadableStream<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), "bloks-say-"));
    const out = join(dir, "speech.m4a");
    const child = execFile(
      "/usr/bin/say",
      ["-v", voice, "-o", out, "--file-format=m4af", "--data-format=aac", "-f", "-"],
      { timeout: 60_000 },
      (error) => {
        try {
          if (error) throw error;
          const audio = readFileSync(out);
          resolve(Readable.toWeb(Readable.from([audio])) as ReadableStream<Uint8Array>);
        } catch (e) {
          reject(new Error(`the Mac voice could not speak: ${(e as Error).message}`));
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
    child.stdin?.end(text);
  });
}

export function speechConfigured(cfg: AppConfig): {
  elevenlabs: boolean;
  openai: boolean;
  fish: boolean;
  xai: boolean;
  /** Which key xAI speaks with: one saved for speech, or the Grok
   * engine's. Absent with neither. */
  xaiSource?: "speech" | "grok";
  chatterbox: boolean;
  /** Not a secret: the person's own server, shown so the field prefills. */
  chatterboxUrl?: string;
  /** The Mac's own voices, which need nothing set up. */
  system: boolean;
  /** In use, from consented discovery: where it came from. */
  openaiSource?: "env" | "codex";
  /** Found but NOT in use: awaiting the user's yes. */
  openaiAvailable?: "env" | "codex";
  /** What turns speech into text, and what it could be. */
  hearing: HearingStatus;
} {
  const discovered = cfg.speech?.openaiKey ? null : discoveredOpenAIKey();
  const consented = Boolean(cfg.speech?.useDiscoveredOpenAI);
  const xai = xaiKey(cfg);
  const chatterbox = chatterboxUrl(cfg);
  return {
    elevenlabs: Boolean(cfg.speech?.elevenlabsKey),
    openai: Boolean(openaiKey(cfg)),
    fish: Boolean(cfg.speech?.fishKey),
    xai: Boolean(xai),
    ...(xai ? { xaiSource: xai.source } : {}),
    chatterbox: Boolean(chatterbox),
    ...(chatterbox ? { chatterboxUrl: chatterbox } : {}),
    system: MAC_VOICES,
    ...(discovered && consented ? { openaiSource: discovered.source } : {}),
    ...(discovered && !consented ? { openaiAvailable: discovered.source } : {}),
    hearing: hearingStatus(cfg),
  };
}

async function elevenlabsVoices(key: string): Promise<Voice[]> {
  const voices: Voice[] = [];
  try {
    const res = await fetch(`${elevenlabsBase()}/v1/voices`, {
      headers: { "xi-api-key": key },
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    if (res.ok) {
      const body: any = await res.json();
      for (const v of body.voices ?? []) {
        if (typeof v?.voice_id === "string" && typeof v?.name === "string") {
          voices.push({ provider: "elevenlabs", id: v.voice_id, name: v.name });
        }
      }
    }
  } catch {
    // the vendor being down should not empty the whole picker
  }
  return voices;
}

/** Every voice the current keys can actually produce, asked of every
 * vendor at once so the picker waits on the slowest, not on the sum. */
export async function listVoices(cfg: AppConfig): Promise<Voice[]> {
  const xai = xaiKey(cfg);
  const chatterbox = chatterboxUrl(cfg);
  const lists = await Promise.all([
    cfg.speech?.elevenlabsKey ? elevenlabsVoices(cfg.speech.elevenlabsKey) : [],
    openaiKey(cfg) ? OPENAI_VOICES : [],
    cfg.speech?.fishKey ? fishVoices(cfg.speech.fishKey) : [],
    xai ? xaiVoices(xai.key) : [],
    chatterbox ? chatterboxVoices(chatterbox) : [],
    // last: the voices somebody set up on purpose come before the ones
    // that came with the Mac
    macVoices(),
  ]);
  return lists.flat();
}

/**
 * Text to a byte stream of speech. The vendor's own streaming endpoint
 * is used so playback can start before synthesis finishes.
 */
export async function speak(
  cfg: AppConfig,
  voice: BotVoice,
  text: string,
): Promise<{ stream: ReadableStream<Uint8Array>; mime: string }> {
  const clipped = text.slice(0, SPEAK_MAX_CHARS);
  if (voice.provider === "system") {
    if (!MAC_VOICES) throw new Error("Mac voices need Bloks running on a Mac.");
    // only a voice the Mac actually lists, never an arbitrary argument
    if (!(await macVoices()).some((v) => v.id === voice.id)) throw new Error("that Mac voice is not installed");
    return { stream: await sayToStream(voice.id, clipped), mime: "audio/mp4" };
  }
  if (voice.provider === "elevenlabs") {
    const key = cfg.speech?.elevenlabsKey;
    if (!key) throw new Error("no ElevenLabs key configured");
    const res = await fetch(
      `${elevenlabsBase()}/v1/text-to-speech/${encodeURIComponent(voice.id)}/stream?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({
          text: clipped,
          // the turbo model is the latency choice: a call that answers in
          // two seconds feels like a call, five feels like voicemail
          model_id: "eleven_turbo_v2_5",
        }),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!res.ok || !res.body) {
      throw new Error(`ElevenLabs refused: ${res.status} ${(await res.text().catch(() => "")).slice(0, 140)}`);
    }
    return { stream: res.body, mime: "audio/mpeg" };
  }
  if (voice.provider === "fish") return speakFish(cfg, voice, clipped);
  if (voice.provider === "xai") return speakXai(cfg, voice, clipped);
  if (voice.provider === "chatterbox") return speakChatterbox(cfg, voice, clipped);

  const key = openaiKey(cfg);
  if (!key) throw new Error("no OpenAI speech key configured");
  const res = await fetch(`${openaiBase()}/v1/audio/speech`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: voice.id,
      input: clipped,
      response_format: "mp3",
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok || !res.body) {
    throw new Error(`OpenAI speech refused: ${res.status} ${(await res.text().catch(() => "")).slice(0, 140)}`);
  }
  return { stream: res.body, mime: "audio/mpeg" };
}

type Spoken = { stream: ReadableStream<Uint8Array>; mime: string };

/** A hosted vendor's request, with no answer at all said as such: the
 * bare "fetch failed" names nothing anyone could fix. */
async function reach(vendor: "fish" | "xai", url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    const name = VENDOR_NAMES[vendor];
    const slow = (e as { name?: string })?.name === "TimeoutError";
    throw new Error(
      slow ? `${name} took too long to answer. Try again in a moment.` : `${name} could not be reached. Check the internet connection, then try again.`,
    );
  }
}

/** Fish Audio streams the audio as it is made (chunked), so playback
 * starts before the sentence is finished, the same as ElevenLabs. */
async function speakFish(cfg: AppConfig, voice: BotVoice, text: string): Promise<Spoken> {
  const key = cfg.speech?.fishKey;
  if (!key) throw new Error("No Fish Audio key is saved. Add one in Settings, Voices.");
  const res = await reach("fish", `${fishBase()}/v1/tts`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      text,
      reference_id: voice.id,
      format: "mp3",
      // the latency choice, for the same reason as ElevenLabs' turbo
      latency: "balanced",
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok || !res.body) throw new Error(speechError("fish", res.status, await res.text().catch(() => "")));
  return { stream: res.body, mime: "audio/mpeg" };
}

/** xAI answers a whole clip: audio bytes, or JSON carrying them as
 * base64 (its reference shows both), read either way. */
async function speakXai(cfg: AppConfig, voice: BotVoice, text: string): Promise<Spoken> {
  const key = xaiKey(cfg);
  if (!key) throw new Error("No xAI key is saved. Add one in Settings, Voices, or connect Grok in Settings, Engines.");
  const res = await reach("xai", `${xaiBase()}/v1/tts`, {
    method: "POST",
    headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" },
    body: JSON.stringify({
      text,
      voice_id: voice.id,
      // a reply is in whatever language it was written in
      language: "auto",
      output_format: { codec: "mp3" },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok || !res.body) throw new Error(speechError("xai", res.status, await res.text().catch(() => ""), { keyFrom: key.source }));
  const type = res.headers.get("content-type") ?? "";
  if (/json/i.test(type)) {
    const body: any = await res.json().catch(() => null);
    if (typeof body?.audio !== "string" || !body.audio) throw new Error("xAI answered without any audio. Try again.");
    const audio = Buffer.from(body.audio, "base64");
    const mime = typeof body.content_type === "string" && /^audio\//.test(body.content_type) ? body.content_type : "audio/mpeg";
    return { stream: Readable.toWeb(Readable.from([audio])) as ReadableStream<Uint8Array>, mime };
  }
  return { stream: res.body, mime: /^audio\//.test(type) ? type.split(";")[0] : "audio/mpeg" };
}

/** A Chatterbox server, by the OpenAI-shaped route the servers people run
 * share. The default voice is asked for by naming none. The model is
 * local and slow to start, so it is given longer than a hosted vendor. */
async function speakChatterbox(cfg: AppConfig, voice: BotVoice, text: string): Promise<Spoken> {
  const url = chatterboxUrl(cfg);
  if (!url) throw new Error("No Chatterbox server is set. Add its address in Settings, Voices.");
  let res: Response;
  try {
    res = await fetch(`${url}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatterbox",
        input: text,
        ...(voice.id && voice.id !== CHATTERBOX_DEFAULT.id ? { voice: voice.id } : {}),
        response_format: "mp3",
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    throw chatterboxUnreachable(url, e);
  }
  if (!res.ok || !res.body) throw new Error(speechError("chatterbox", res.status, await res.text().catch(() => ""), { where: url }));
  // some servers ignore response_format and send WAV; say what came
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  return { stream: res.body, mime: /^audio\//.test(type) ? type : "audio/wav" };
}

// ── hearing, as well as speaking ──────────────────────────────────────
// The same keys turn speech into text: a voice message sent from a phone,
// what you say on a call, and a meeting being taken down. A Whisper
// server of the person's own does it with no key and no account; after
// that ElevenLabs, then OpenAI, the same order as everything else here.
// The Mac's own recognizer hears in the app's window instead
// (electron/resources/speech-helper.swift), so it is a choice the person
// makes here but never one a server can carry out.
//
// Sound comes in a stretch at a time, is passed on, and is gone: held in
// memory for the one request, never written down and never logged.

export const HEARING_CHOICES = ["auto", "whisper", "elevenlabs", "openai", "mac"] as const;
export type HearingChoice = (typeof HEARING_CHOICES)[number];
/** The ones that hear here, on the server. */
export type Hearer = "whisper" | "elevenlabs" | "openai";
const HEARERS: readonly Hearer[] = ["whisper", "elevenlabs", "openai"];
const HEARER_NAMES: Record<Hearer, string> = { whisper: "The Whisper server", elevenlabs: "ElevenLabs", openai: "OpenAI" };

/** OpenAI's newer transcription model, which hears names and noisy
 * rooms better than whisper-1 does. */
export const OPENAI_TRANSCRIBE_MODEL = "gpt-transcribe";
export const ELEVENLABS_TRANSCRIBE_MODEL = "scribe_v2";
/** The model a Whisper server is asked for: most serve one and ignore
 * the name, and the rest take OpenAI's own name for it. */
export const WHISPER_MODEL = "whisper-1";

/** The most one stretch of speech may be. A minute of what a page
 * records is about a quarter of a megabyte; this leaves room for a
 * browser that records something less compressed. */
export const HEAR_MAX_BYTES = 8 * 1024 * 1024;

export interface HearingStatus {
  choice: HearingChoice;
  /** Who hears on the server: the one chosen, when it is set up; the
   * first that is, for automatic and for the Mac (whose recognizer only
   * the app's window has, so anything else hears with this); or null. */
  engine: Hearer | null;
  whisper: boolean;
  /** Not a secret: the person's own server, shown so the field prefills. */
  whisperUrl?: string;
}

export function hearingChoice(cfg: AppConfig): HearingChoice {
  const saved = cfg.speech?.hearing;
  return (HEARING_CHOICES as readonly string[]).includes(saved ?? "") ? (saved as HearingChoice) : "auto";
}

/** Who turns speech into text here, or null with nothing set up. */
export function hearer(cfg: AppConfig): Hearer | null {
  const ready: Record<Hearer, boolean> = {
    whisper: Boolean(whisperUrl(cfg)),
    elevenlabs: Boolean(cfg.speech?.elevenlabsKey),
    openai: Boolean(openaiKey(cfg)),
  };
  const choice = hearingChoice(cfg);
  if (choice === "whisper" || choice === "elevenlabs" || choice === "openai") return ready[choice] ? choice : null;
  return HEARERS.find((h) => ready[h]) ?? null;
}

export function hearingStatus(cfg: AppConfig): HearingStatus {
  const whisper = whisperUrl(cfg);
  return {
    choice: hearingChoice(cfg),
    engine: hearer(cfg),
    whisper: Boolean(whisper),
    ...(whisper ? { whisperUrl: whisper } : {}),
  };
}

/** Why nothing can hear, said as the thing to set up. */
export function nobodyHears(cfg: AppConfig): string {
  switch (hearingChoice(cfg)) {
    case "whisper":
      return "Hearing is set to your Whisper server, but none is saved. Add its address in Settings, Voices.";
    case "elevenlabs":
      return "Hearing is set to ElevenLabs, but no ElevenLabs key is saved. Add one in Settings, Voices.";
    case "openai":
      return "Hearing is set to OpenAI, but no OpenAI key is saved for speech. Add one in Settings, Voices.";
    default:
      return "Nothing is set up to hear you. Add an OpenAI or ElevenLabs key, or a Whisper server of your own, in Settings, Voices.";
  }
}

/** A recording that could not be turned into text. `status` is the
 * answer when one came; `vendor` is null when nothing could hear at all. */
export class HearingError extends Error {
  readonly vendor: Hearer | null;
  readonly status?: number;
  constructor(message: string, vendor: Hearer | null, status?: number) {
    super(message);
    this.vendor = vendor;
    this.status = status;
  }
}

/**
 * A refused transcription, said as what to do about it. Never the
 * vendor's own words: what they echo back can be the audio's words, or
 * the key, and this is shown on screens and sent to phones.
 */
export function hearingError(vendor: Hearer, status: number, where?: string): string {
  if (vendor === "whisper") {
    const at = where ?? "the Whisper server";
    if (status === 404 || status === 405) {
      return `${at} answered, but not as a Whisper server: it has no /v1/audio/transcriptions. Check the address in Settings, Voices.`;
    }
    if (status === 400 || status === 413 || status === 415 || status === 422) return `The Whisper server could not read that recording (${status}). Try again.`;
    if (status >= 500) return `The Whisper server failed to hear that (${status}). Its own log says why.`;
    return `The Whisper server at ${at} answered ${status}.`;
  }
  const name = HEARER_NAMES[vendor];
  if (status === 401 || status === 403) return `${name} did not accept the key. Paste a new one in Settings, Voices.`;
  if (status === 402) return `${name} says the account has no credit left. Add some, then try again.`;
  if (status === 429) return `${name} is limiting requests just now, or the account is out of credit. Try again shortly.`;
  if (status === 400 || status === 413 || status === 415 || status === 422) return `${name} could not read that recording (${status}). Try again.`;
  if (status >= 500) return `${name} is not answering properly right now (${status}). Try again shortly.`;
  return `${name} answered ${status}.`;
}

/** Why a transcription never got an answer at all. */
function unheard(vendor: Hearer, where: string | undefined, error: unknown): HearingError {
  const slow = ["TimeoutError", "AbortError"].includes((error as { name?: string })?.name ?? "");
  if (vendor === "whisper") {
    return new HearingError(
      slow
        ? `The Whisper server at ${where} took too long to answer. A first request can be slow while the model loads; try again.`
        : `Nothing answered at ${where}. Start the Whisper server, or check the address in Settings, Voices.`,
      vendor,
    );
  }
  const name = HEARER_NAMES[vendor];
  return new HearingError(
    slow ? `${name} took too long to answer. Try again in a moment.` : `${name} could not be reached. Check the internet connection, then try again.`,
    vendor,
  );
}

/** The filename a recording goes under. The vendors read the format from
 * it, so it has to say what the bytes are. */
export function clipName(mime: string): string {
  const type = mime.split(";")[0].trim().toLowerCase();
  const ext: Record<string, string> = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "audio/m4a": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "m4a",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/wave": "wav",
    "audio/x-wav": "wav",
    "audio/flac": "flac",
  };
  return `speech.${ext[type] ?? "webm"}`;
}

/**
 * A recording to text, by whoever hears here. `name` matters more than
 * it looks: the vendors read the format from the filename, and refuse a
 * Telegram voice note named `.oga` though it is the same Ogg Opus they
 * take as `.ogg`.
 */
export async function hear(cfg: AppConfig, audio: Uint8Array, mime: string, name = clipName(mime)): Promise<{ text: string; by: Hearer }> {
  const by = hearer(cfg);
  if (!by) throw new HearingError(nobodyHears(cfg), null);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mime.split(";")[0].trim() }), name);
  let url: string;
  let headers: Record<string, string> = {};
  const where = by === "whisper" ? whisperUrl(cfg)! : undefined;
  if (by === "elevenlabs") {
    form.append("model_id", ELEVENLABS_TRANSCRIBE_MODEL);
    url = `${elevenlabsBase()}/v1/speech-to-text`;
    headers = { "xi-api-key": cfg.speech!.elevenlabsKey! };
  } else if (by === "openai") {
    form.append("model", OPENAI_TRANSCRIBE_MODEL);
    url = `${openaiBase()}/v1/audio/transcriptions`;
    headers = { authorization: `Bearer ${openaiKey(cfg)}` };
  } else {
    form.append("model", WHISPER_MODEL);
    form.append("response_format", "json");
    url = `${where}/v1/audio/transcriptions`;
  }
  let res: Response;
  try {
    // a local model on a small machine can take a while over a minute of speech
    res = await fetch(url, { method: "POST", headers, body: form, signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    throw unheard(by, where, e);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new HearingError(hearingError(by, res.status, where), by, res.status);
  }
  const body: any = await res.json().catch(() => null);
  return { text: typeof body?.text === "string" ? body.text.trim().slice(0, 20_000) : "", by };
}

/** A voice message from a phone, to text. */
export async function transcribe(cfg: AppConfig, audio: Uint8Array, name: string, mime: string): Promise<string> {
  try {
    return (await hear(cfg, audio, mime, name)).text;
  } catch (e) {
    // Only the status: this ends up in a reply on somebody's phone, said
    // inside a sentence of its own.
    if (e instanceof HearingError && e.vendor && e.status) throw new Error(`${HEARER_NAMES[e.vendor]} answered ${e.status}`);
    throw e;
  }
}

/** A client-supplied voice, shape-checked. */
export function parseBotVoice(raw: unknown): BotVoice | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;
  if (typeof v.provider !== "string" || !(VOICE_PROVIDERS as readonly string[]).includes(v.provider)) return undefined;
  if (typeof v.id !== "string" || !v.id || v.id.length > 120) return undefined;
  return {
    provider: v.provider as VoiceProvider,
    id: v.id,
    ...(typeof v.name === "string" ? { name: v.name.slice(0, 80) } : {}),
  };
}
