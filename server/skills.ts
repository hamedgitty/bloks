// The skill library.
//
// A skill is a reusable instruction set, when to use it, what it needs,
// the sequence of work, how to validate the result, and what needs
// approval. Skills live as markdown files in ~/.bloks/skills, one per
// file, with YAML-ish frontmatter for the name and description. Agents
// attach them by id, and an attached skill's body is composed into that
// agent's system prompt.
//
// Security note: an installed skill is literally text injected into every
// turn, it is the highest-trust content in the app. So installation is
// explicit and reviewable, bodies are size-capped, ids are slugs that can
// never escape the skills directory, and nothing is ever fetched and
// installed on the app's own initiative.
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { SKILLS_DIR } from "./config.ts";

export interface Skill {
  id: string;
  name: string;
  description: string;
  /** The instructions themselves, and what reaches the model. */
  body: string;
  /** builtin skills ship with the app and cannot be edited or deleted. */
  source: "builtin" | "user";
  /** Set when this came from the catalog: which entry, which version, and
   * the hash of the body as it was installed. The last one is what makes
   * "you have edited this" answerable rather than guessed at. */
  registry?: string;
  version?: string;
  sha256?: string;
}

/** Hard caps: a skill lands in every prompt, so a runaway file would
 * quietly eat the context window (and the user's tokens). */
export const MAX_SKILL_BYTES = 16_000;
export const MAX_USER_SKILLS = 200;

// ── what actually reaches the prompt ───────────────────────────────────
//
// Every attached skill used to be sent whole, every turn. That was fine
// while a library was something a person filled in by hand and stopped at
// half a dozen. It stops being fine once the library grows on its own,
// because the cost is paid on every turn forever and the skill that
// matters today is one of thirty.
//
// So above a size, a skill is sent as its name and what it is for, and
// the agent reads the rest when it decides it needs it. Two rules keep
// that from being a downgrade.
//
//   A short skill is still sent whole. A round trip to fetch two hundred
//   characters costs more than the two hundred characters, and most
//   skills are short. This is insurance against a library that grows,
//   not a saving to be extracted from one that has not.
//
//   Nothing is withheld from an agent that cannot go and get it. Only
//   some engines are given a credential, and holding a skill back from
//   one that has no way to read it would be losing the instruction
//   rather than deferring it.

/**
 * Under this many characters a skill is sent whole.
 *
 * Roughly two hundred tokens. Set so that the skills Bloks ships, all of
 * them a few hundred characters, are unaffected: what this is for is the
 * long procedure with steps and pitfalls, which is the kind that is worth
 * a round trip and the kind a library accumulates.
 */
export const INLINE_UNDER = 800;

export interface Disclosure {
  /** Sent whole, as before. */
  inline: Skill[];
  /** Sent as a name and a description, to be read on demand. */
  indexed: Skill[];
}

export function disclose(skills: Skill[], canFetch: boolean, under: number = INLINE_UNDER): Disclosure {
  if (!canFetch) return { inline: skills, indexed: [] };
  const inline: Skill[] = [];
  const indexed: Skill[] = [];
  for (const skill of skills) {
    // A skill with nothing to say about itself cannot be indexed: the
    // description is the whole basis for deciding to read it.
    const readable = skill.description.trim().length > 0;
    if (!readable || skill.body.length <= Math.max(0, under)) inline.push(skill);
    else indexed.push(skill);
  }
  return { inline, indexed };
}

/**
 * The skills section of a system prompt, or null when there is none.
 *
 * `howToRead` is passed in rather than known here, because how an agent
 * fetches a skill is a fact about the credential it was given and this
 * file has no business knowing about that.
 */
export function skillsPrompt(disclosure: Disclosure, howToRead: string): string | null {
  const parts: string[] = [];
  if (disclosure.inline.length) {
    parts.push(
      `You have these skills installed. Follow the matching one whenever a request calls for it:\n\n${disclosure.inline
        .map((s) => `## ${s.name}\n${s.body}`)
        .join("\n\n")}`,
    );
  }
  if (disclosure.indexed.length) {
    parts.push(
      [
        "You also have these skills, kept out of this prompt because they are long. Each one says what it is for. When a request calls for one, read it before starting, and follow it:",
        "",
        disclosure.indexed.map((s) => `- ${s.id}: ${s.name}. ${s.description}`).join("\n"),
        "",
        howToRead,
      ].join("\n"),
    );
  }
  return parts.length ? parts.join("\n\n") : null;
}

/** Lowercase, dash-separated, no path separators or dots, a slug can
 * never traverse out of the skills directory. */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "skill";
}

/** Frontmatter parse: `---\nname: X\ndescription: Y\n---\n<body>`. */
function parseMarkdown(markdown: string): {
  name?: string;
  description?: string;
  body: string;
  registry?: string;
  version?: string;
  sha256?: string;
} {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { body: markdown.trim() };

  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return {
    name: meta.name,
    description: meta.description,
    body: match[2].trim(),
    registry: meta.registry,
    version: meta.version,
    sha256: meta.sha256,
  };
}

function serialize(
  skill: Pick<Skill, "name" | "description" | "body"> & Partial<Pick<Skill, "registry" | "version" | "sha256">>,
): string {
  const escape = (v: string) => v.replace(/\r?\n/g, " ").trim();
  return [
    "---",
    `name: ${escape(skill.name)}`,
    `description: ${escape(skill.description)}`,
    // only present when it came from the catalog, so a hand-written skill
    // stays a plain file with nothing in it to explain
    ...(skill.registry ? [`registry: ${escape(skill.registry)}`] : []),
    ...(skill.version ? [`version: ${escape(skill.version)}`] : []),
    ...(skill.sha256 ? [`sha256: ${escape(skill.sha256)}`] : []),
    "---",
    "",
    skill.body.trim(),
    "",
  ].join("\n");
}

/** Falls back to the first heading, then the filename, for a name. */
function nameFrom(body: string, fallback: string): string {
  const heading = body.match(/^#{1,3}\s+(.+)$/m);
  return (heading?.[1] ?? fallback).trim().slice(0, 80);
}

// ── the bundled pack ──────────────────────────────────────────────────
// Starter skills every install gets. Read-only: editing one produces a
// user copy rather than mutating the original.
const BUILTIN: Array<Omit<Skill, "source">> = [
  {
    id: "daily-brief",
    name: "Daily brief",
    description: "One short plan for the day, leading with what needs a decision",
    body: `Use this when asked for a brief, a plan for the day, or "what's on".

1. Gather: today's calendar, open tasks, and threads awaiting a reply.
2. Group into: needs a decision from me, happening today, and waiting on someone else.
3. Lead with the decisions. Never open with a greeting or a summary of what you're about to say.
4. Keep it under 150 words. If something slipped since yesterday, say so and why.

Return: a short plain-text brief. No tables, no headers unless there are more than three groups.
Approval: none needed, this is read-only.`,
  },
  {
    id: "inbox-triage",
    name: "Inbox triage",
    description: "Sort new mail into needs-me, routine, and noise",
    body: `Use this when processing an inbox.

1. Read only what arrived since the last run.
2. Classify each message: needs-me, routine (safe to draft), or noise.
3. For routine mail, draft a reply in the user's voice and hold it.
4. Escalate immediately, without waiting for the batch: anything financial, legal, security-related, time-sensitive within 24h, or from a named VIP.

Return: counts per class, the escalations in full, and the drafts awaiting approval.
Approval: required before sending anything. Never send on your own.`,
  },
  {
    id: "research-brief",
    name: "Research brief",
    description: "Investigate a topic and return a short sourced brief",
    body: `Use this for any research request.

1. Start with primary sources (the actual documentation, filing, or repository) before commentary about them.
2. Cross-check any load-bearing claim against a second independent source.
3. Separate clearly: established fact, contested, and your own inference.
4. Say plainly when the evidence is thin. A short honest brief beats a long confident one.

Return: the answer in the first two sentences, then supporting detail, then sources as links.
Approval: none needed unless the research requires paid access or account creation.`,
  },
  {
    id: "code-review",
    name: "Code review",
    description: "Review a diff for correctness bugs and needless complexity",
    body: `Use this when reviewing code or a pull request.

1. Read the surrounding code first. Conventions here beat conventions in general.
2. Hunt correctness bugs before style: wrong logic, unhandled errors, race conditions, off-by-ones, missing awaits.
3. Then note genuine simplifications. Do not invent nitpicks to fill space.
4. For each finding give: the file and line, what breaks, and the concrete input that would break it.

Return: findings ordered most-severe first. If the diff is clean, say so in one line.
Approval: required before pushing any change.`,
  },
  {
    id: "meeting-prep",
    name: "Meeting prep",
    description: "Assemble context and an agenda before a meeting",
    body: `Use this ahead of any scheduled meeting.

1. Identify attendees and what each cares about.
2. Pull the history: last conversation, open commitments on both sides, anything promised and not delivered.
3. Surface what changed since you last spoke.
4. Propose an agenda with the single most important item first.

Return: half a page maximum. Who, what changed, what to decide, suggested agenda.
Approval: none needed, this is read-only.`,
  },
  {
    id: "weekly-review",
    name: "Weekly review",
    description: "What shipped, what slipped, and the biggest risk ahead",
    body: `Use this at the end of a working week.

1. List what actually shipped, not what was worked on.
2. List what slipped, each with the real reason, not "ran out of time".
3. Name the single biggest risk to next week and what would defuse it.
4. Note anything that has now slipped two weeks running; that is a pattern, not a delay.

Return: three short sections and one risk. Under 200 words.
Approval: none needed, this is read-only.`,
  },
  {
    id: "outreach-draft",
    name: "Outreach draft",
    description: "Write outreach that references something specific and true",
    body: `Use this when drafting cold email or messages to a prospect.

1. Research the account first. If you cannot find something specific and true about them, say so and skip them rather than writing filler.
2. Open with that specific thing, not with who you are.
3. One clear ask. No multi-part questions.
4. Match the user's voice from their previous messages. Never use "I hope this finds you well", "circling back", or "just following up".

Return: subject line and body, under 120 words.
Approval: always required before sending. Never send outreach on your own.`,
  },
  {
    id: "expense-coding",
    name: "Expense coding",
    description: "Categorize transactions consistently and flag anomalies",
    body: `Use this when processing transactions or receipts.

1. Categorize using the categories already present in the user's history. Do not invent new ones.
2. When a transaction is ambiguous, ask. Never guess a category to finish the batch.
3. Flag: duplicate charges, subscriptions with no recent use, and anything more than 50% above its own historical average.
4. Note any charge missing a receipt so the user can find it while they still remember it.

Return: counts by category, the flags, and the list of missing receipts.
Approval: required before categorizing anything as personal or writing to an accounting system.`,
  },
];

// ── reading ───────────────────────────────────────────────────────────

function readUserSkills(): Skill[] {
  let entries: string[];
  try {
    entries = readdirSync(SKILLS_DIR);
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const file = join(SKILLS_DIR, entry);
    try {
      if (statSync(file).size > MAX_SKILL_BYTES * 2) continue;
      const raw = readFileSync(file, "utf8");
      const parsed = parseMarkdown(raw);
      if (!parsed.body.trim()) continue;
      const id = slugify(entry.replace(/\.md$/, ""));
      skills.push({
        id,
        name: parsed.name?.trim() || nameFrom(parsed.body, id.replace(/-/g, " ")),
        description: parsed.description?.trim() || "",
        body: parsed.body.slice(0, MAX_SKILL_BYTES),
        source: "user",
        ...(parsed.registry ? { registry: parsed.registry } : {}),
        ...(parsed.version ? { version: parsed.version } : {}),
        ...(parsed.sha256 ? { sha256: parsed.sha256 } : {}),
      });
    } catch {
      /* unreadable file, skip rather than fail the whole list */
    }
  }
  return skills;
}

export function listSkills(): Skill[] {
  const user = readUserSkills();
  const userIds = new Set(user.map((s) => s.id));
  // a user file with a builtin's id shadows it, so a bundled skill can be
  // customized without losing the original on disk
  const builtin = BUILTIN.filter((b) => !userIds.has(b.id)).map(
    (b): Skill => ({ ...b, source: "builtin" }),
  );
  return [...builtin, ...user].sort((a, b) => a.name.localeCompare(b.name));
}

export function getSkills(ids: string[]): Skill[] {
  if (!ids.length) return [];
  const wanted = new Set(ids);
  return listSkills().filter((s) => wanted.has(s.id));
}

// ── writing ───────────────────────────────────────────────────────────

export interface InstallInput {
  /** A whole markdown document, frontmatter optional. */
  markdown?: string;
  /** Where it came from, when that is the catalog. */
  registry?: string;
  version?: string;
  sha256?: string;
  /** Or the pieces directly. */
  name?: string;
  description?: string;
  body?: string;
  /** Suggested id (e.g. the dropped filename); slugified regardless. */
  id?: string;
}

export function installSkill(input: InstallInput): Skill {
  const fromDoc = input.markdown ? parseMarkdown(input.markdown) : null;
  const body = (input.body ?? fromDoc?.body ?? "").trim();
  if (!body) throw Object.assign(new Error("a skill needs instructions"), { status: 400 });
  if (Buffer.byteLength(body, "utf8") > MAX_SKILL_BYTES) {
    throw Object.assign(new Error(`skills are limited to ${MAX_SKILL_BYTES} characters`), {
      status: 413,
    });
  }

  const name = (input.name ?? fromDoc?.name ?? nameFrom(body, input.id ?? "skill")).trim();
  const description = (input.description ?? fromDoc?.description ?? "").trim().slice(0, 200);
  const id = slugify(input.id ?? name);

  const existing = readUserSkills();
  if (existing.length >= MAX_USER_SKILLS && !existing.some((s) => s.id === id)) {
    throw Object.assign(new Error("skill library is full"), { status: 507 });
  }

  // Editing a skill that came from the catalog keeps where it came from.
  // Losing that would make an edited skill indistinguishable from one
  // somebody wrote themselves, and the catalog would then offer to
  // "replace what you wrote" rather than say plainly that this is its
  // own skill with your changes on top.
  const before = existing.find((s) => s.id === id);
  const from = {
    registry: input.registry ?? before?.registry,
    version: input.version ?? before?.version,
    sha256: input.sha256 ?? before?.sha256,
  };

  mkdirSync(SKILLS_DIR, { recursive: true, mode: 0o700 });
  const file = join(SKILLS_DIR, `${id}.md`);
  writeFileSync(
    file,
    serialize({ name, description, body, ...from }),
    { mode: 0o600 },
  );
  try {
    chmodSync(file, 0o600);
  } catch {
    /* non-POSIX filesystem */
  }
  return {
    id,
    name,
    description,
    body,
    source: "user",
    ...(from.registry ? { registry: from.registry } : {}),
    ...(from.version ? { version: from.version } : {}),
    ...(from.sha256 ? { sha256: from.sha256 } : {}),
  };
}

export function deleteSkill(id: string): boolean {
  const slug = slugify(id);
  try {
    unlinkSync(join(SKILLS_DIR, `${slug}.md`));
    return true;
  } catch {
    return false;
  }
}
