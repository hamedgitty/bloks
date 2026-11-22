// Models for the owner's agents, changed by one instruction of the owner's
// in chat (GitHub 544).
//
// A proposal (server/model-proposals.ts) puts a card in front of the owner
// at the computer Bloks runs on, and nothing changes until Apply. That is
// right for a list an agent made up, and for a switch of engine, which
// reaches other sign-ins and keys. It is in the way when the owner has
// already said exactly what they want, from a paired Mac or their own
// private Telegram chat with a workspace on a server: "move everyone on
// Opus 5 to Opus 5.5" should be done, and said back, in that chat.
//
// The agent that reads the instruction is not what authorises it. An
// agent has its own permissions, and whatever lands in its context can
// try to steer it, so it gets no standing say over other agents' models.
// What it can do is name the owner's message. The server then reads that
// message itself, as stored, and decides everything from it:
//
//   whose it is: the owner's own words, typed in the app, on a paired
//   device, or in the owner's own private Telegram chat. Never a member's,
//   a guest's, another agent's, a routine's, a webhook's, mail, a bridge,
//   a Telegram contact or group, or anything the server wrote itself;
//
//   where and when: in the calling agent's own conversation, at most
//   INSTRUCTION_MAX_AGE_MS old, the newest of the owner's messages there
//   or the one this turn answers, and not edited since it was heard;
//
//   once: the result is kept on the message, so a second call for it
//   changes nothing and answers what the first one did;
//
//   what it says: read here by a small set of rules, not by the agent.
//   "Change all from A to B", "switch Ada and Ben to B", "move everyone
//   except Cy from A to B", "upgrade all to the latest version", in
//   English or Ukrainian, typed or dictated. Anything quoted, asked,
//   negated, conditional or reported is not an instruction, an exception
//   that cannot be read is never dropped to make it "all", and words
//   that could mean two things mean nothing: the agent is told to ask
//   which model the owner means.
//
// What it may change is narrow on purpose: the primary model of the
// owner's own agents, on the engine each is on already. No engine switch,
// no account, key, permission, effort, backup or default, and nothing of
// a member's own agent. Both models have to be ones that engine takes,
// as its picker would: listed, or on an engine that runs any id, a typed
// id held to the picker's rule. "The latest version" is only what Bloks'
// own model catalog says replaces a model (ModelCatalog `successor`):
// the provider's own word where its engine reports one, or a pair kept
// with the engine's built in list. A family alias is not a lineage, and
// a model with none known is asked about rather than guessed.
//
// Pure: reading the message, the words and the change set. Checking it
// again, writing it and saying it back are server/index.ts's.
import type { Message } from "./store.ts";
import { pickerTakes, sideOf, type AgentView, type EngineView, type ModelTarget, type ModelWorld } from "./model-proposals.ts";

/** How long the owner's words stay an instruction. Long enough to have
 * sent it from a phone and had the agent pick it up after a queue; short
 * enough that an old message scrolled past is not a standing order. */
export const INSTRUCTION_MAX_AGE_MS = 30 * 60_000;

/** The most an instruction is read at. A few sentences say it; a longer
 * message is a discussion, and the agent should ask. */
export const MAX_INSTRUCTION_CHARS = 400;

/** The most agents one instruction changes. More is a migration, for the
 * agents' settings. */
export const MAX_INSTRUCTION_TARGETS = 50;

/** The steps of a successor chain followed for "the latest version". */
const MAX_LINEAGE = 12;

// ── whose words, where and when ─────────────────────────────────────────

/** Why a message is not the owner's own words, or null when it is. */
export function notOwners(m: Message): string | null {
  if (m.role !== "user") return "it is an agent's message, not the owner's";
  if (m.kind !== "text" || !m.text?.trim()) return "it has no words of the owner's";
  if (m.deleted || m.rewound) return "it was taken back";
  if (m.queued || m.unsent) return "it has not reached you yet";
  if (m.author && m.author !== "owner") return "a member or a guest wrote it, not the owner";
  if (m.selfSent) return "an agent wrote it, not the owner";
  if (m.agent || m.afterAgent || m.from || m.takeBack || m.chainHeld || m.heldSays) return "another agent wrote it, not the owner";
  if (m.routine || m.intent || m.incident || m.goal || m.serviceWake || m.event) return "Bloks wrote it for a routine, a goal or a notice, not the owner";
  if (m.via) return `it came in by ${m.via}, not from the owner`;
  if (m.onBehalf) return "it was sent on somebody's behalf";
  if (m.telegramGroup) return "it was said in a Telegram group, not the owner's own private chat";
  if (m.telegramPerson || m.telegramDelegate) return "somebody other than the owner said it on Telegram";
  if (m.fromSignal) return "it came from Signal, which does not carry instructions like this";
  if (m.imported || m.branch) return "it was brought over from another conversation";
  if (m.preparation && (m.preparation.dismissed || !["joined", "next"].includes(m.preparation.state))) return "its delivery is not settled";
  return null;
}

/** When the owner wrote it: before any wait in a queue. */
const writtenAt = (m: Message) => m.queuedAt ?? m.at;

/**
 * The owner's message an agent named, if it is one this can act on: in
 * this conversation, the owner's own words, recent, not edited after it
 * was heard, and the newest of the owner's messages here or the one the
 * turn running now answers. No id is the newest. Every refusal says why,
 * so the agent can tell the owner rather than try again.
 */
export function instructionMessage(
  lane: readonly Message[],
  id: string | undefined,
  now: number,
  turnStartedAt?: number,
): { ok: true; message: Message } | { ok: false; status: number; error: string } {
  const owners = lane.filter((m) => !notOwners(m));
  const newest = owners.at(-1);
  const message = id ? lane.find((m) => m.id === id) : newest;
  if (!message) {
    return id
      ? { ok: false, status: 404, error: "There is no message with that id in this conversation. Only an instruction the owner gave here can be carried out." }
      : { ok: false, status: 404, error: "The owner has not given an instruction in this conversation." };
  }
  const why = notOwners(message);
  if (why) return { ok: false, status: 403, error: `That message cannot change any models: ${why}. Only the owner's own words change other agents' models; ask them.` };
  if (message.editedAt && message.editedAt > (message.deliveredAt ?? message.at)) {
    return { ok: false, status: 409, error: "The owner edited that message after you read it, so it is not carried out. Ask them to send the instruction again." };
  }
  if (now - writtenAt(message) > INSTRUCTION_MAX_AGE_MS) {
    return { ok: false, status: 409, error: `That instruction is more than ${INSTRUCTION_MAX_AGE_MS / 60_000} minutes old, so it is not carried out. Ask the owner whether they still want it.` };
  }
  // the one this turn took up: the owner's last words before it started
  const answering = turnStartedAt === undefined ? undefined : owners.filter((m) => (m.deliveredAt ?? m.at) <= turnStartedAt).at(-1);
  if (message.id !== newest?.id && message.id !== answering?.id) {
    return { ok: false, status: 409, error: "The owner has said something newer than that message here, so it is not carried out. Read what they said since and ask them if it is unclear." };
  }
  return { ok: true, message };
}

// ── what the words say ──────────────────────────────────────────────────

export type Scope = { kind: "all"; except: string[] } | { kind: "named"; names: string[] };

export type Instruction =
  | { kind: "change"; scope: Scope; from?: string; to: string }
  | { kind: "upgrade"; scope: Scope; from?: string };

export type Parsed = { ok: true; instruction: Instruction } | { ok: false; reason: string };

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
/** Any of the words, as whole words in any script. */
const wordsOf = (list: readonly string[]) => new RegExp(`(?<![\\p{L}\\p{N}_'])(?:${list.map(escape).join("|")})(?![\\p{L}\\p{N}_'])`, "u");
/** Any of the words at the very start. */
const startOf = (list: readonly string[]) => new RegExp(`^(?:${list.map(escape).join("|")})(?![\\p{L}\\p{N}_'])`, "u");

/** The verbs of a change. Ukrainian in the imperative, the infinitive
 * (after "треба") and the past (after "хочу, щоб ти"). */
const UK_STEMS: Array<[string, string[]]> = [
  ["змін", ["и", "іть", "ити", "ив", "ила", "или"]],
  ["онов", ["и", "іть", "ити", "ив", "ила", "или"]],
  ["переключ", ["и", "іть", "ити", "ив", "ила", "или"]],
  ["перемкн", ["и", "іть", "ути", "ув", "ула", "ули"]],
  ["замін", ["и", "іть", "ити", "ив", "ила", "или"]],
  ["постав", ["", "те", "ити", "ив", "ила", "или"]],
  ["встанов", ["и", "іть", "ити", "ив", "ила", "или"]],
];
const UK_VERBS = [...UK_STEMS.flatMap(([stem, ends]) => ends.map((end) => stem + end)), "переведи", "переведіть", "перевести", "перевів", "перевела", "перевели"];
const EN_VERBS = ["change", "update", "switch", "move", "set", "upgrade", "migrate"];
const VERB = startOf([...EN_VERBS, ...UK_VERBS]);
const ANY_VERB = wordsOf([...EN_VERBS, ...UK_VERBS]);
/** Verbs that stand alone for "to the newest". Not "update", which says
 * too little without a "to". */
const UPGRADE_ALONE = new Set(["upgrade"]);

const QUESTION_START = startOf([
  "can", "could", "would", "will", "should", "shall", "do", "does", "did", "is", "are", "was", "were", "have", "has", "may", "might", "must",
  "why", "how", "what", "which", "when", "where", "who", "whom", "whose",
  "чи", "як", "чому", "навіщо", "нащо", "що", "коли", "де", "хто", "який", "яка", "яке", "які", "скільки", "можеш", "можете", "можна", "зможеш", "зможете", "міг", "могла", "могли",
]);
const QUESTION_ANY = wordsOf(["whether", "чи"]);
const NEGATION = wordsOf([
  "not", "no", "never", "nothing", "nobody", "none", "neither", "nor", "without", "cancel", "stop", "dont", "cant", "wont", "shouldnt", "hold off",
  "не", "ні", "ніколи", "нічого", "ніхто", "жоден", "жодна", "жодного", "жодних", "без", "скасуй", "скасуйте", "стоп", "відміни", "відмініть",
]);
const CONTRACTED_NOT = /\p{L}n't(?!\p{L})/u;
const CONDITIONAL = wordsOf([
  "if", "unless", "when", "whenever", "once", "until", "till", "before", "after", "in case", "as soon as", "provided", "assuming", "suppose", "otherwise",
  "якщо", "якби", "коли", "як тільки", "щойно", "у разі", "в разі", "хіба", "поки", "доки", "після", "перед", "би", "б", "інакше",
]);
const REPORTED = wordsOf([
  "said", "says", "say", "told", "asked", "asks", "wants", "wanted", "wrote", "writes", "mentioned", "mentions", "suggested", "suggests", "claims", "claimed", "according", "reportedly", "apparently", "supposedly", "quote", "quoting", "heard",
  "сказав", "сказала", "сказали", "каже", "кажуть", "казав", "казала", "казали", "просив", "просила", "просили", "просить", "написав", "написала", "написали", "пише", "пишуть",
  "хоче", "хочуть", "хотів", "хотіла", "хотіли", "питав", "питала", "питає", "запитав", "запитала", "порадив", "порадила", "радить", "мовляв", "нібито", "ніби", "цитую", "цитата",
]);

/** Words that open an instruction without changing it, taken off the front. */
const PREAMBLE = startOf([
  "please", "kindly", "ok", "okay", "alright", "all right", "so", "now", "right", "well", "just", "go ahead and", "and",
  "i want you to", "i'd like you to", "i would like you to", "i need you to", "we need to", "let's", "lets",
  "будь ласка", "будь-ласка", "прошу", "давай", "давайте", "добре", "гаразд", "окей", "ок", "так", "ну", "тепер", "зараз", "отже", "просто", "слухай", "слухайте",
  "я хочу щоб ти", "хочу щоб ти", "я хочу щоб ви", "мені треба щоб ти", "мені потрібно щоб ти", "треба", "потрібно", "необхідно",
]);
const GREETING = /^(?:hi|hey|hello|привіт|вітаю)(?:\s+[\p{L}\p{N}._-]+)?(?=,|$)/u;
/** Words that close an instruction without changing it, taken off the end. */
const TRAILER = /(?:\s|^)(?:please|thanks|thank you|thx|now|right now|for me|asap|будь ласка|будь-ласка|дякую|зараз|тепер|одразу|негайно)$/u;
/** "... and tell me what changed": the report the agent gives anyway. */
const REPORT_CLAUSE = /\s(?:and|then|і|й|та|а)\s(?:tell|let|report|show|confirm|скажи|повідом|напиши|покажи|підтверди)(?![\p{L}])[\s\S]*$/u;
/** A sentence that is nothing but courtesy. */
const COURTESY = /^(?:(?:hi|hey|hello|thanks|thank you|thx|cheers|please|ok|okay|great|good|cool|привіт|вітаю|дякую|спасибі|будь ласка|будь-ласка|добре|гаразд|окей|ок|чудово)[\s,]*)+$/u;

const ALL_WORDS = new Set(["all", "every", "each", "everyone", "everybody", "everything", "всі", "усі", "всіх", "усіх", "всім", "усім", "кожного", "кожному", "кожен", "кожна", "кожну"]);
const FILLER = new Set([
  "the", "my", "our", "your", "their", "of", "them", "agents", "agent", "bots", "bot", "models", "model", "primary", "primaries", "ones", "one", "current", "ai",
  "агенти", "агентів", "агентам", "агента", "агенту", "агентах", "боти", "ботів", "моделі", "моделей", "модель", "моделям", "основні", "основну", "основних", "основна",
  "у", "в", "для", "їх", "їхні", "їхню", "мої", "моїх", "моїм", "наші", "наших", "свої", "своїх",
]);
const PLURALS = new Set(["agents", "bots", "models", "primaries", "ones", "агенти", "агентів", "агентам", "агентах", "боти", "ботів", "моделі", "моделей", "моделям"]);
const NEW_VERSION = /^(?:the\s+)?(?:new|newest|newer|latest|next|most recent)(?:\s+(?:version|versions|model|models|release|releases|one|ones))?$|^(?:нової|новішої|новітньої|останньої|найновішої|свіжої|найсвіжішої|нову|новішу|останню|найновішу|новітню)(?:\s+(?:версії|версію|моделі|модель|версій))?$/u;

const tidy = (text: string) => text.replace(/^[\s,:;.!-]+|[\s,:;.!-]+$/g, "").replace(/\s+/g, " ");
const possessive = (word: string) => word.replace(/'s$|'$/u, "");

/** The words as one plain line: one script of apostrophes and hyphens,
 * lower case, one space. Hyphen look-alikes are a model id's hyphen. */
function plain(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u2019\u02bc\u2032]/g, "'")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Quoting: a quoted command is somebody's words, never this one. A quoted
 * model name is only a name, and loses its marks. Null when what is quoted
 * holds a command, or a quote is left open. */
function unquote(text: string): string | null {
  const pairs: Array<[string, string]> = [["\u201c", "\u201d"], ["\u201e", "\u201c"], ["\u201e", "\u201d"], ["\u00ab", "\u00bb"], ["\u2018", "\u2019"], ["\"", "\""], ["`", "`"]];
  let out = text;
  for (const [open, close] of pairs) {
    const span = new RegExp(`${escape(open)}([^${escape(open)}${escape(close)}]*)${escape(close)}`, "gu");
    let bad = false;
    out = out.replace(span, (_, inside: string) => {
      if (ANY_VERB.test(plain(inside))) bad = true;
      return inside;
    });
    if (bad) return null;
  }
  // a single straight quote around words, not an apostrophe in one
  out = out.replace(/(^|\s)'([^']+)'(?=\s|$|[.,!?;:])/gu, (_, before: string, inside: string) => (ANY_VERB.test(plain(inside)) ? "\u0000" : `${before}${inside}`));
  if (out.includes("\u0000")) return null;
  if (/["\u201c\u201d\u201e\u00ab\u00bb\u2018`]/u.test(out)) return null;
  return out;
}

/** The sentences: a full stop counts only before a space or the end, so
 * "5.5" stays one model. */
function sentences(text: string): string[] {
  return text.split(/[!;\n]+|\.(?=\s|$)/u).map((s) => s.trim()).filter(Boolean);
}

/** A sentence without its opening and closing courtesy. */
function bare(sentence: string): string {
  let s = tidy(sentence);
  for (let i = 0; i < 8; i++) {
    const before = s;
    s = tidy(s.replace(/\s*,\s*(щоб)(?![\p{L}])/u, " $1").replace(GREETING, "").replace(PREAMBLE, "").replace(/^щоб\s+(?:ти|ви)(?![\p{L}])/u, "").replace(TRAILER, ""));
    if (s === before) break;
  }
  return s;
}

/** Names in a list: "ada", "ada and ben", "ada, ben та cy". */
function nameList(text: string): string[] | null {
  const items = tidy(text).split(/\s*,\s*|\s+(?:and|&|і|й|та)\s+/u).map((item) => tidy(item.split(" ").map(possessive).filter((w) => !["model", "models", "primary", "модель", "моделі"].includes(w)).join(" ")));
  if (!items.length || items.some((item) => !item || item.split(" ").some((w) => ALL_WORDS.has(w)))) return null;
  return items;
}

/** A scope as said: everyone, everyone on a model, or agents by name. */
function scopeOf(text: string): { scope: Scope; from?: string } | null {
  const said = tidy(text);
  if (!said) return null;
  const words = said.replace(/,/g, " ").split(/\s+/).map(possessive);
  const all = words.some((w) => ALL_WORDS.has(w));
  const rest = words.filter((w) => !ALL_WORDS.has(w) && !FILLER.has(w));
  if (all) {
    if (!rest.length) return { scope: { kind: "all", except: [] } };
    // "all opus 5 agents": everyone on a model, said between the two
    const first = words.findIndex((w) => ALL_WORDS.has(w));
    const last = words.length - 1;
    if (first === 0 && PLURALS.has(words[last]!)) {
      const middle = words.slice(1, last).filter((w) => !["the", "my", "our"].includes(w));
      if (middle.length && middle.every((w) => !ALL_WORDS.has(w) && !PLURALS.has(w))) return { scope: { kind: "all", except: [] }, from: middle.join(" ") };
    }
    return null;
  }
  if (!rest.length) return words.some((w) => PLURALS.has(w)) ? { scope: { kind: "all", except: [] } } : null;
  const names = nameList(said);
  return names ? { scope: { kind: "named", names } } : null;
}

/** A model as said: without "the" in front or "model" behind. */
function modelOf(text: string): string {
  return tidy(text.replace(/^(?:the|a|an)\s+/u, "").replace(/\s+(?:model|models|version|модель|моделі|версію|версії)$/u, ""));
}

/** The first of the markers after `from`, as [index, length], or null. */
function firstMarker(text: string, markers: readonly string[], from = 0): [number, number] | null {
  let best: [number, number] | null = null;
  for (const marker of markers) {
    const at = text.indexOf(marker, from);
    if (at >= 0 && (!best || at < best[0])) best = [at, marker.length];
  }
  return best;
}

/** The last of the markers, as [index, length], or null. */
function lastMarker(text: string, markers: readonly string[]): [number, number] | null {
  let best: [number, number] | null = null;
  for (const marker of markers) {
    const at = text.lastIndexOf(marker);
    if (at >= 0 && (!best || at > best[0])) best = [at, marker.length];
  }
  return best;
}

const EN_TO = [" to "];
const UK_TO = [" на ", " до "];
const EN_FROM = [" from ", " currently on ", " that are on ", " which are on ", " that use ", " that run ", " using ", " running ", " on "];
const UK_FROM = [" з ", " із ", " зі ", " які зараз на ", " які на ", " що на "];
const EXCEPT = [" except for ", " except ", " apart from ", " other than ", " excluding ", " but ", " крім ", " окрім ", " за винятком "];
const FOR = [" for ", " для "];

/** One instruction sentence, its verb first. */
function instructionOf(sentence: string): Instruction | null {
  const verb = VERB.exec(sentence)?.[0];
  if (!verb) return null;
  const body = ` ${tidy(sentence.slice(verb.length).replace(REPORT_CLAUSE, ""))} `;
  const uk = UK_VERBS.includes(verb);
  const to = lastMarker(body, uk ? UK_TO : EN_TO);
  // in Ukrainian an earlier "на" is "on": "агентів на A на B"
  const fromMarkers = uk && to ? [...UK_FROM, ...(body.slice(0, to[0]).includes(" на ") ? [" на "] : [])] : uk ? UK_FROM : EN_FROM;
  const from = firstMarker(body.slice(0, to ? to[0] : body.length), fromMarkers);
  const except = firstMarker(body, EXCEPT);
  const cuts = [from?.[0], to?.[0], except?.[0]].filter((n): n is number => n !== undefined);
  const segment = (at: [number, number] | null) => {
    if (!at) return undefined;
    const end = Math.min(...cuts.filter((n) => n > at[0]), body.length);
    return tidy(body.slice(at[0] + at[1], end));
  };
  let scopeText = tidy(body.slice(0, cuts.length ? Math.min(...cuts) : body.length));
  let toText = segment(to);
  // "to B for everyone": the scope said after the model
  if (toText !== undefined) {
    const forAt = firstMarker(` ${toText} `, FOR);
    if (forAt) {
      if (scopeText) return null;
      scopeText = tidy(` ${toText} `.slice(forAt[0] + forAt[1]));
      toText = tidy(` ${toText} `.slice(0, forAt[0]));
    }
  }
  const read = scopeOf(scopeText);
  if (!read) return null;
  const fromText = segment(from);
  if (fromText !== undefined && read.from) return null;
  const fromModel = fromText !== undefined ? modelOf(fromText) : read.from;
  if (fromModel !== undefined && !fromModel) return null;
  let scope = read.scope;
  const exceptText = segment(except);
  if (exceptText !== undefined) {
    // an exception is to "all"; one that cannot be read is never dropped
    const names = nameList(exceptText);
    if (scope.kind !== "all" || !names) return null;
    scope = { kind: "all", except: names };
  }
  if (toText === undefined) {
    return UPGRADE_ALONE.has(verb) ? { kind: "upgrade", scope, ...(fromModel ? { from: fromModel } : {}) } : null;
  }
  const toModel = modelOf(toText);
  if (!toModel) return null;
  if (NEW_VERSION.test(toText) || NEW_VERSION.test(toModel)) return { kind: "upgrade", scope, ...(fromModel ? { from: fromModel } : {}) };
  return { kind: "change", scope, ...(fromModel ? { from: fromModel } : {}), to: toModel };
}

/**
 * The owner's words as one instruction, or why they are not one. Bounded
 * and literal on purpose: what is not plainly a single direct instruction
 * is not carried out, and the agent asks.
 */
export function parseInstruction(text: string): Parsed {
  if (!text.trim()) return { ok: false, reason: "there are no words to read" };
  if (text.length > MAX_INSTRUCTION_CHARS) return { ok: false, reason: "the message is too long to read as one instruction" };
  const unquoted = unquote(text);
  if (unquoted === null) return { ok: false, reason: "the instruction is quoted, so it is somebody's words rather than the owner's own" };
  const line = plain(unquoted);
  if (line.includes("?") || QUESTION_ANY.test(line)) return { ok: false, reason: "it is a question, not an instruction" };
  if (NEGATION.test(line) || CONTRACTED_NOT.test(line)) return { ok: false, reason: "it says not to, or not yet" };
  if (CONDITIONAL.test(line)) return { ok: false, reason: "it depends on something first" };
  if (REPORTED.test(line)) return { ok: false, reason: "it reports what somebody said rather than saying it" };
  const found: Instruction[] = [];
  for (const sentence of sentences(line)) {
    const s = bare(sentence);
    if (!s || COURTESY.test(s) || (GREETING.test(s) && tidy(s.replace(GREETING, "")) === "")) continue;
    if (QUESTION_START.test(s)) return { ok: false, reason: "it is a question, not an instruction" };
    const instruction = instructionOf(s);
    if (!instruction) return { ok: false, reason: "it does not say plainly which agents to change and to which model" };
    found.push(instruction);
  }
  if (!found.length) return { ok: false, reason: "it does not ask for a change of model" };
  if (found.length > 1) return { ok: false, reason: "it holds more than one instruction" };
  return { ok: true, instruction: found[0]! };
}

// ── which models, on which engines ──────────────────────────────────────

/** A model's words as keys to compare: lower case, any run of spaces,
 * dots, slashes and colons a hyphen. */
const key = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[\s._/:-]+/g, "-").replace(/^-+|-+$/g, "");

/** A key and the same key without a maker's name in front, as the owner
 * says it: "claude-opus-5-5" is also "opus-5-5". Never down to a number
 * ("gpt-5" is not "5") or to one bare word ("codex-mini" is not "mini"). */
function keysOf(text: string): string[] {
  const out = [key(text)];
  for (let k = out[0]!; ; ) {
    const cut = k.indexOf("-");
    if (cut < 0) break;
    const rest = k.slice(cut + 1);
    if (!/^\p{L}/u.test(rest) || !(rest.includes("-") || /\d/.test(rest))) break;
    out.push(rest);
    k = rest;
  }
  return out;
}

type Resolved = { id: string; label?: string; unlisted?: true } | "ambiguous" | null;

/** A model the owner named, on one engine: listed, its default, or on an
 * engine that runs any id, an id the picker would take that is no prefix
 * of a listed one ("fable" when there are three). */
export function modelNamed(engine: EngineView, asked: string): Resolved {
  const exact = engine.options.find((o) => o.id === asked.trim());
  if (exact) return exact;
  const want = key(asked);
  if (!want) return null;
  const hits = engine.options.filter((o) => [...keysOf(o.id), ...(o.label ? keysOf(o.label) : [])].includes(want));
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) return "ambiguous";
  if (engine.default && keysOf(engine.default).includes(want)) return { id: engine.default };
  const typed = asked.trim();
  if (!engine.acceptsAnyId || /\s/.test(typed) || !pickerTakes(typed)) return null;
  if (engine.options.some((o) => [...keysOf(o.id), ...(o.label ? keysOf(o.label) : [])].some((k) => k.startsWith(`${want}-`)))) return "ambiguous";
  return { id: typed, unlisted: true };
}

/** What Bloks' catalog says replaces a model on its engine, followed to
 * the newest: null when nothing does, and "newest" when the model is the
 * end of a chain it knows. */
export function newestOf(engine: EngineView, id: string): { id: string; label?: string } | "newest" | null {
  const listed = (x: string) => engine.options.find((o) => o.id === x);
  let at = listed(id);
  const seen = new Set<string>([id]);
  let next: { id: string; label?: string } | null = null;
  for (let i = 0; i < MAX_LINEAGE && at?.successor; i++) {
    const after = listed(at.successor);
    if (!after || seen.has(after.id)) break;
    seen.add(after.id);
    next = after;
    at = after;
  }
  if (next) return next;
  return engine.options.some((o) => o.successor === id) ? "newest" : null;
}

/** An agent named in an instruction: by its name, any case, when only one
 * has it; in Ukrainian, also with a case ending on either side ("Аду",
 * "Ади" for "Ада"), when that still names one. */
function agentCalled(agents: readonly AgentView[], asked: string): AgentView | string {
  const want = asked.trim().toLowerCase();
  const named = agents.filter((a) => a.name.trim().toLowerCase() === want || a.id === asked.trim());
  if (named.length === 1) return named[0]!;
  if (named.length > 1) return `more than one agent is called "${asked.slice(0, 60)}"`;
  const stem = (s: string) => s.replace(/(?:ою|ею|ові|еві|ом|ем|а|я|и|і|у|ю|ї|о|е)$/u, "");
  if (/\p{Script=Cyrillic}/u.test(want) && stem(want).length >= 2) {
    const near = agents.filter((a) => a.name.trim().length >= 3 && stem(a.name.trim().toLowerCase()) === stem(want));
    if (near.length === 1) return near[0]!;
    if (near.length > 1) return `more than one agent could be "${asked.slice(0, 60)}"`;
  }
  return `no agent of the owner's is called "${asked.slice(0, 60)}"`;
}

export interface Skipped {
  botId: string;
  name: string;
  why: string;
}

export type InstructionPlan =
  | { ok: true; read: string; changes: ModelTarget[]; skipped: Skipped[] }
  | { ok: false; read?: string; ask: string };

/** What the server read, in words, for the report. */
export function readBack(instruction: Instruction): string {
  const scope = instruction.scope.kind === "named"
    ? instruction.scope.names.join(", ")
    : instruction.scope.except.length ? `every agent except ${instruction.scope.except.join(", ")}` : "every agent";
  const from = instruction.from ? ` on ${instruction.from}` : "";
  return instruction.kind === "upgrade" ? `upgrade ${scope}${from} to the newest version Bloks knows` : `change ${scope}${from} to ${instruction.to}`;
}

/**
 * The change set an instruction makes, read against the owner's agents and
 * their engines as they are now: each agent's primary model, on the engine
 * it is on. Agents it does not change are said with the reason. When the
 * words cannot be made into one change set (an agent or a model nobody
 * has, a model that could be two), nothing is planned and the agent is to
 * ask the owner.
 */
export function planInstruction(instruction: Instruction, world: ModelWorld): InstructionPlan {
  const read = readBack(instruction);
  const ask = (why: string): InstructionPlan => ({ ok: false, read, ask: why });
  let inScope: AgentView[];
  if (instruction.scope.kind === "named") {
    inScope = [];
    for (const name of instruction.scope.names) {
      const agent = agentCalled(world.agents, name);
      if (typeof agent === "string") return ask(`${agent}. Ask the owner which agent they mean`);
      if (!inScope.includes(agent)) inScope.push(agent);
    }
  } else {
    const left = new Set<string>();
    for (const name of instruction.scope.except) {
      const agent = agentCalled(world.agents, name);
      // an exception nobody can find is not dropped, which would make it "all"
      if (typeof agent === "string") return ask(`the exception says ${agent}. Ask the owner which agent they mean to leave out`);
      left.add(agent.id);
    }
    inScope = world.agents.filter((a) => !left.has(a.id));
  }
  const engines = new Map(world.engines.map((e) => [e.id, e]));
  const changes: ModelTarget[] = [];
  const skipped: Skipped[] = [];
  let fromSomewhere = !instruction.from;
  let toSomewhere = false;
  let lineageUnknown = 0;
  for (const agent of inScope) {
    const skip = (why: string) => skipped.push({ botId: agent.id, name: agent.name, why });
    if (!agent.selection) {
      skip("it has no engine set");
      continue;
    }
    const engine = engines.get(agent.selection.instanceId);
    if (!engine) {
      skip(`its engine ${agent.selection.instanceId} is not set up here`);
      continue;
    }
    const now = agent.selection.model || engine.default;
    const nowSide = sideOf(engine, engine.id, agent.selection.model);
    if (instruction.from) {
      const was = modelNamed(engine, instruction.from);
      if (was === "ambiguous") return ask(`"${instruction.from}" could be more than one model on ${engine.name}. Ask the owner which one they mean`);
      if (was) fromSomewhere = true;
      if (!was || was.id !== now) {
        skip(`it is on ${nowSide.label}, not ${instruction.from}`);
        continue;
      }
    }
    let to: { id: string; label?: string; unlisted?: true };
    if (instruction.kind === "upgrade") {
      const newest = newestOf(engine, now);
      if (newest === "newest") {
        skip(`${nowSide.label} is the newest version Bloks knows on ${engine.name}`);
        continue;
      }
      if (!newest) {
        lineageUnknown++;
        skip(`Bloks does not know which model replaces ${nowSide.label} on ${engine.name}; ask the owner which model they mean`);
        continue;
      }
      to = newest;
    } else {
      const named = modelNamed(engine, instruction.to);
      if (named === "ambiguous") return ask(`"${instruction.to}" could be more than one model on ${engine.name}. Ask the owner which one they mean`);
      // a model another engine lists is a switch of engine, which this never makes
      const elsewhere = world.engines.some((e) => e.id !== engine.id && e.options.some((o) => o.id === instruction.to.trim() || [...keysOf(o.id), ...(o.label ? keysOf(o.label) : [])].includes(key(instruction.to))));
      if (!named || (named.unlisted && elsewhere)) {
        skip(`${engine.name} has no model "${instruction.to}"${elsewhere ? "; moving it to another engine is a proposal for the owner to apply (`bloks models propose`)" : ""}`);
        continue;
      }
      to = named;
    }
    toSomewhere = true;
    if (to.id === now) {
      skip(`it is on ${nowSide.label} already`);
      continue;
    }
    changes.push({ botId: agent.id, name: agent.name, from: nowSide, to: sideOf(engine, engine.id, to.id) });
  }
  if (!fromSomewhere) return ask(`no engine of the owner's agents has a model "${instruction.from}". Ask the owner which model they mean`);
  if (!changes.length && instruction.kind === "change" && !toSomewhere && skipped.some((s) => s.why.includes("has no model"))) {
    return ask(`no engine of the agents asked about has a model "${instruction.to}". Ask the owner which model they mean`);
  }
  if (!changes.length && instruction.kind === "upgrade" && lineageUnknown) {
    return ask("Bloks knows of no newer version of the models those agents are on. Ask the owner which model they mean");
  }
  if (changes.length > MAX_INSTRUCTION_TARGETS) {
    return ask(`that would change ${changes.length} agents, and one instruction changes ${MAX_INSTRUCTION_TARGETS} at most. Ask the owner to change them in parts, or in each agent's settings`);
  }
  return { ok: true, read, changes, skipped };
}
