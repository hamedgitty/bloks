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
//
// Every change to a skill of the person's is kept as a version beside it
// (server/skill-history.ts), whoever made it, and a writer that says
// which version it read is refused when the skill has moved on since.
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { DATA_DIR, SKILLS_DIR } from "./config.ts";
import { closeHeld, openInside, readHeld } from "./open-inside.ts";
import { SkillHistory, sameText, type Author, type Revision } from "./skill-history.ts";

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
 * quietly eat the context window (and the user's tokens). The length is
 * in characters, not bytes, so a skill written in Russian or Chinese gets
 * the same room as one written in English. */
export const MAX_SKILL_CHARS = 16_000;
export const MAX_USER_SKILLS = 200;

/** A file on disk can be this many bytes before it is not read at all.
 * Four bytes is the most one character takes in UTF-8, and the rest is
 * room for the frontmatter, so a skill at the limit in any script fits. */
const MAX_SKILL_FILE_BYTES = MAX_SKILL_CHARS * 4 + 4_000;

/** Characters as a person counts them. Code points rather than
 * `.length`, which would count an emoji or a rare CJK character twice. */
export function countChars(text: string): number {
  return [...text].length;
}

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
      // "whenever a request calls for it" is doing real work here: a
      // skill that fires on everything adjacent to its subject is worse
      // than no skill, because it turns a one-line answer into a
      // procedure. Each body carries its own "Not for:" line for the
      // same reason.
      `You have these skills installed. Follow the matching one whenever a request calls for it, and only then. Each says what it is not for; when that applies, answer directly instead:\n\n${disclosure.inline
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
export function parseMarkdown(markdown: string): {
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

Not for: a single lookup. If they asked what one meeting is, answer that and stop.
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

Not for: one named message. Read and answer that one rather than sorting the whole inbox.
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

Not for: a fact you already hold, or one lookup that a single source settles. Answer it plainly instead.
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

Not for: a question about how code works, or a change you were asked to make. Explain or write it instead.
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

Not for: a meeting already under way, or one with no attendees and no history worth assembling.
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

Not for: a question about one project. Answer that project rather than reviewing the week.
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

Not for: a reply in an existing thread. Match that thread rather than opening cold.
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

Not for: one receipt somebody asked you to read. Read it and say what it is.
Return: counts by category, the flags, and the list of missing receipts.
Approval: required before categorizing anything as personal or writing to an accounting system.`,
  },
  {
    id: "page-design",
    name: "Page design",
    description: "Read before making a page, report, dashboard or deck someone will open as a file. How to make it clear at a glance and finished on a phone and a Mac, light and dark",
    body: `Use this before you make a file a person will look at: a web page, a report, a comparison, a dashboard, a one pager, a slide deck. It opens in Bloks on a Mac and on an iPhone, so it has to read at 390 pixels wide and in dark mode, and it is judged in the first two seconds.

Not for: a reply in the chat. A short answer, or one with some structure, belongs in the chat, drawn as interface when you can.

## First, does this need a file at all
Most answers do not. A fact, an opinion, a quick pick, a comparison of two or three things on a few points: answer in the chat. Make a file when the person asked for one, or when they will keep it, share it, print it or come back to it, or when the decision has real stakes and more facts than a chat card can hold.

## How much to put in
Depth follows the stakes, not a template. Ask what a careful person would want to know before they act, and give exactly that.
- A cheap choice that is easy to undo: the pick, one line of why, nothing more.
- A purchase or a commitment that costs real money or is hard to undo (a console, a laptop, a plan, a contract): the pick first, then everything that would change it. The real total cost (what is included, what you have to buy as well, the subscription), how each option fits the person's own situation, the trade offs in practice rather than in specs, timing (sales, new models), the risks (warranty, returns, what goes wrong), and where the facts came from. Leaving one of those out makes the person go and look it up, and then the page has failed.
- A report or an analysis: the finding first, then the evidence for it in order of weight, then what is uncertain.
More detail never means more words per fact. It means more facts, each said once, short, and grouped by the question it answers, with the answer always on the first screen.

## How people read a page
They do not read it. They scan it, and decide in about two seconds whether it answers them.
- The eye lands on the biggest thing first, then runs down the left edge, stopping at numbers, bold words and the first two or three words of each line. Put the meaning exactly there.
- Attention is spent, not given. Every extra word, box, color and icon costs some of it, and what is left goes to the answer. Clean is not a style here; it is how the answer gets through.
- People hold three to five things at once. More groups than that and they stop comparing and start skimming.
- A number with its meaning beside it ("$100 less", "2.5 times the graphics power") is read in a glance. A number alone makes the reader do the math, and most will not.
- Sameness is what lets someone compare. Two options described in two different shapes cannot be compared without reading both in full.

## Write it before you style it
1. The headline is the answer, not the topic. "The Series S, unless you want 4K" beats "PS5 vs Xbox Series S: a complete comparison". A subtitle under it says the scope and the date the facts are from.
2. Do the math for them. Differences, totals, per month, per use, the gap between the two: work them out and show the result, with the raw figures beside it in smaller type.
3. Cut. Every sentence that would not change their decision goes; every fact that would change it stays. Labels are one to three words. Lines in cards stay under about twelve words. No paragraph runs past three lines. No intro, no "in this comparison we will", no closing summary of what they just read.
4. Say each fact once, in the place it does the most work. If the price is in the verdict, the table does not need a sentence about the price as well.
5. Replace pros and cons with decision rules: "Choose the PS5 if you want 4K or PlayStation exclusives. Choose the Series S if you want Game Pass and the lower price." People decide on their own situation, not on a list of features.
6. Plain words. No hype, no marketing adjectives ("ultimate", "comprehensive", "powerhouse"), no exclamation marks, no emoji.

## The shape
- Choose the form from the content. A comparison is a table with the better value marked in each row. Numbers over time are one chart. A choice is two or three cards with the same rows in the same order, one marked as the pick. Steps are a numbered list. Not everything needs a chart, and nothing needs all of them.
- The order: headline and scope, the verdict (the pick and the rule for when the other wins), the key numbers, the detail, what would change the answer (a price drop, a date, a missing fact), sources.
- The first screen of a phone holds the headline, the verdict and the key numbers. Someone who reads nothing else has the answer.
- Group by the question each part answers ("What does it really cost", "Which fits how you play"), not by where you found the facts. Three to five sections on a short page, and on a long one keep each section to three to five things.
- Reference detail someone may want but few will read (full spec lists, method notes) goes in a details element they can open. Nothing that would change the decision is hidden.

## The look: quiet, so the content is loud
- Hierarchy by size and weight, not by boxes and colors. Three levels and no more: the big thing (headline, key numbers), the label, the detail in muted type.
- Space is the separator. Use space before a line, a line before a box, and a box only when the content inside is one unit.
- Background plain: #ffffff or #fafafa in light, #0b0b0c or #111113 in dark. Never a gradient behind the page, never a photo behind text.
- Cards, when you need them: one step off the background (#f4f4f5 light, #1a1a1d dark), a hairline border (the text color at 8 to 12 percent), radius 12 to 16px, at most a 0 1px 2px shadow. Cards never sit inside cards.
- One accent color, for the one thing that matters on each screen: the pick, the key number, links. If the subject has no color of its own, a calm blue (#2563eb light, #60a5fa dark), or an indigo (#4f46e5 light, #818cf8 dark) when a brand on the page is already blue. Brand colors appear only as small marks: a dot, a thin bar, a label. Never whole cards, headings or the page.
- Type: font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", sans-serif. Body 16px, line-height 1.5. A short scale: 13, 15, 17, 22, 28, 40. Headings 600 to 700 with letter-spacing -0.01em, -0.02em from 28px up. Key numbers large and tabular: font-variant-numeric: tabular-nums.
- One left edge. Text, numbers and headings line up on it, and repeated items keep their parts in the same place so the eye can run down a column.
- Running text at most about 68 characters wide (max-width: 680px). Spacing on a 4px grid: 8, 12, 16, 24, 32, 48, generous between sections and tight within them.
- Contrast: body text at least 4.5 to 1, muted text included. Muted text #5f6672 in light (it holds on white and on a card), #a1a1aa in dark.
- Leave out: text-shadow, emoji as icons or bullets, all caps sentences, centered paragraphs, borders on every side of everything, decorative images, a second accent. When an icon carries meaning, a small inline SVG with a 1.5 to 2px stroke in currentColor.

## Light and dark
Every color is a CSS variable on :root, redefined inside @media (prefers-color-scheme: dark). Set background and color on body explicitly. Borders, charts and badges use the variables too, so nothing is left white on white or black on black.

## Tables
- First column names the row, one column per option, the same order everywhere on the page.
- Mark the better value in each row (weight 600 or a small accent dot), not every cell. A row where they are equal says so once ("Same") rather than repeating the value.
- Numbers right aligned and tabular. Units in the row label, not in every cell. Seven rows or fewer before you split by theme.
- Hairline row borders, no zebra stripes, no heavy header fill.
- On a phone a wide table scrolls sideways inside its own wrapper (overflow-x: auto) with the first column sticky. The page itself never scrolls sideways.

## Charts
- Only when the shape of the numbers is the point. Axes labeled with units. Three series or fewer are labeled at the line, not in a legend.
- Inline SVG, or a library from a pinned version (for example https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js). The key numbers are in the text too, so the page reads if the script never loads.
- Series colors from the variables, distinct in both themes, and never color alone telling two series apart.

## Interaction, only where it helps
- A toggle between views, a sort on a table header, a filter. Controls look like controls, show a pointer cursor and a focus ring, and are at least 44px tall.
- Nothing only on hover: a phone has no hover.
- One file: CSS in a style element, script in a script element. No CSS frameworks, no hotlinked images. It opens in a sandbox and may be read offline.

## The file
- <!doctype html>, <meta charset="utf-8">, <meta name="viewport" content="width=device-width, initial-scale=1">, and a <title> of two to five words.
- Named for what it is: ps5-vs-xbox-series-s.html, not comparison.html or output.html.
- Under about 200 KB. Images only when they carry information.

## Decks and printed reports
- A deck: one idea per slide, its title a full sentence that states the point, at most three short lines or one chart, the same palette and type as above. The HTML version shows one slide per screen and moves with the arrow keys and a swipe.
- A report for print: @media print with black on white, no card fills, a page break before each section.

## Check before you hand it over
- The five second test: someone who sees only the first screen on a phone can say the answer.
- The squint test: blur your eyes and you see three to five clear blocks, one of them clearly first.
- Read it as the person: every line either helps them decide or goes.
- Nothing overflows at 390px. Dark mode is readable everywhere. Every number has its unit and its date. The sources are there, small, at the bottom.

## In the chat
The file speaks for itself. Your reply is one or two sentences: what you made and its headline, for example "The Series S is the better buy at $499 unless you want 4K; the full comparison is in the card." Do not repeat the page in the chat as a list.

Return: one self contained file in your artifacts folder, and a reply of a sentence or two.
Approval: none needed.`,
  },
  {
    id: "using-bloks",
    name: "Using Bloks",
    description: "Read before acting on Bloks itself for the person: hiring, a new conversation tab or a handoff, rooms, routines, watchers, sharing files, and what only the person can do",
    // Every command `bloks help` lists is named here, which
    // test/agent-tab.test.ts holds it to, so a command added to the CLI
    // without a line here fails the build rather than going unmentioned.
    body: `Use this when the person asks you to do something in Bloks itself: hire or brief an agent, open a new conversation tab, hand work on, set up a room, schedule or watch for something, share a file, or arrange the sidebar. You do it with the bloks command line. Run \`bloks help\` for the exact flags of the version installed; this says which command fits.

Not for: the work itself. Do what was asked; reach for these only when Bloks has to change.

## Which conversation
- A new tab: \`tab <agent-id|me> "<first message>" --title "<name>"\` opens a conversation of its own for you (me) or another agent, with that message in it. Use it when the work should be kept apart ("start a new tab for the setup"). The person's screen stays where it is.
- A handoff: \`say <agent-id> "<text>"\` goes to that agent's first conversation, starting a turn there or waiting behind the one running. \`--task <name>\` only names the work for counting turns between agents; it never opens a tab. \`--now\` is for a correction to a turn already running. \`take-back\` withdraws your words still waiting.
- A fresh session: \`fresh\` keeps the conversation you are in and its transcript, and starts your next turn there without the old engine context. Keep what matters with \`memory\` first. \`rename\`, \`close\` and \`summary\` also act only on the conversation you are in.

## People and rooms
- \`agents\` and \`rooms\` list who and what exists, with ids; \`whoami\` is you. Use ids from there, never guessed ones.
- \`hire\` adds a teammate. \`stop\` and \`archive\` act only on an agent you hired or lead.
- A room for shared work: \`room --name "<name>" --members "id,id"\` (you are added), then brief it with \`say <room-id> "<brief>"\`, naming with @Name each agent whose part it is. \`history <room-id>\` reads it.
- \`sidebar\` shows the arrangement; \`file\`, \`pin\` and \`unpin\` change where a row sits.
- \`message-person\` writes to one person privately, only when the owner or an admin asked you to in a team conversation or a room.

## Work that comes back
- \`routine\` files a time of day or a check-in for you; \`routines\` lists them, \`unroutine\` drops one.
- \`watch\` looks at a folder, a page, a feed, a command or a place and acts on a change; \`watchers\`, \`edit-watch\`, \`unwatch\`. \`watch-app\` (see \`app-events\`) only proposes: nothing listens until the person says yes.
- \`intent\` proposes a standing intent for the person to approve; \`intents\`, \`unintent\`.
- \`post\` puts work on the job board for whoever takes it; \`jobs\` reads it.
- \`pause\`, \`pauses\` and \`unpause\` hold an engine for your own work, up to a day.
- \`incident\` reads a failure you lead and retries it once, hands it on, or tells the person.

## Files, answers and the person
- \`share <file>\` puts a file in the chat as a card and gives a link; \`telegram\` sends one to their Telegram chat with your bot; \`show\` answers with a chart or a table.
- \`secret\` asks for a key through a secure field; never ask for one in the chat. \`note\` suggests a fact about the person for them to keep or not.
- \`questions\` lists the questions you asked without waiting that nobody has answered. Once the person settles one some other way, \`unask <id>\` withdraws it, so it stops asking for them; nothing is answered for them.
- \`memory\` and \`recall\` are your own notes and past conversations. \`skills\` and \`skill\` read the library; \`skill revise\` only proposes a change.
- \`settings\`, \`goal\` and \`location\` only read; \`settings propose\` only proposes. \`browser\` drives the Bloks browser while the person watches. \`home\` asks Home Assistant, and a change waits for their yes unless they marked it auto. \`reply\` answers the group message that started this turn.

## What only the person can do
Say so plainly, and show them where rather than naming a page from memory:
- \`where <words>\` finds the page and the way there in words. \`open <page-id>\` puts a card in the chat whose one button takes them there; it only opens the page.
- \`settings propose\` lists the few everyday settings you may change for them, on a card they answer with Change or Keep. Anything else is theirs to change.
- Answer a card, switch which tab is open, rewind, delete an agent, set a goal (/goal in the chat).
- Always theirs: approvals and rules, the limit on agents writing to agents, engines, sign-ins and keys, members and invites, phones and Bloks Cloud, the plan and spending limits, backups and moving or exporting a workspace, the browser's sites, Home Assistant. Point them there with \`open\`.
- How a feature works and where it lives: the how-bloks-works skill.

## Say what happened
Every command answers JSON. Report what it said: the tab's title and id, whether it started or is queued, an engine warning, a card waiting. A refusal means nothing happened: say why in a sentence and what the person can do, and do not look for another way around it.

Return: a sentence or two on what changed, or on what the person needs to do.
Approval: anything that waits on a card (an app watcher, an intent, a skill revision, a change to the home, a secret) is not done until the person says yes; say it is waiting.`,
  },
  {
    id: "how-bloks-works",
    name: "How Bloks works",
    description: "Read when the person asks how Bloks works, what a feature does, where something is, or why Bloks did something: each feature, where it lives, and what you can do about it versus what only they can",
    // Every Settings page id is named here, which test/agent-guide.test.ts
    // holds it to, so a page added to the app without a line here fails
    // the build rather than going unexplained. Written from README.md and
    // docs/ARCHITECTURE.md; a feature that changes changes here too.
    body: `Use this when the person asks how Bloks works, what a feature does, where something is, or why Bloks did something: explain it plainly, say where it lives, and say what you can do about it and what only they can. Each part below ends with where it is; the word in backticks is the page id.

Not for: doing the work itself, or acting on Bloks (the using-bloks skill says which command fits). Not for a question you can answer from the conversation.

## Pointing the person somewhere
- \`where <words>\` searches the same index the app's settings search uses and answers the page, the path in words and the matching rows. Use it rather than your memory: pages move.
- \`open <page-id> [--row "<row>"]\` puts a card in this conversation with one button that opens that page in their window, and scrolls to the row on a Settings page. It changes nothing. On a phone or in a browser the page may not open, so say the path in words as well.
- \`settings propose\` lists the few everyday settings you may change for them; \`settings propose <setting> <value> --why "<reason>"\` puts a card with Change and Keep in front of them. Nothing changes until they tap Change, and then it changes as theirs, in the record. Approvals, keys, people, devices, plans, limits, backups and deleting are refused: send them there with \`open\`.

## Turns and conversations
A message starts a turn on the agent's engine; the reply streams in, with what it runs. Before and after each turn Bloks photographs the agent's folder, and a card under the reply lists the changed files with one Undo. Rewind takes a conversation back to a message they sent, files too. The flask runs a turn as a rehearsal on a copy of the folder, to apply or discard; several agents can try the same task. Each agent has conversations of its own (tabs). Where: the chat; an agent's own settings (\`agent\`). You: \`tab\`, \`rename\`, \`close\`, \`fresh\`. Only the person: undo, rewind, rehearsals, switching tabs.

## Messages while an agent works
Said mid-turn, a message is read first. Automatic: a stop stops, a correction or an answer to the agent's question goes in now, the rest waits its turn. Interrupt sends everything in now; Queue always waits. One tap flips a waiting message to now. Where: Settings, Behaviour, Messages while an agent works (\`behaviour\`), and per agent in its settings (\`agent\`). Only the person sets it.

## Long conversations
Claude Code compacts its own session when it fills. Settings, Behaviour can compact long chats, summarise as you go, and compact while idle (off unless chosen). A new session on an old conversation (another engine, a backup, a rewind) is told a bounded story: the running summary, then recent messages. Where: \`behaviour\`. You: \`summary\` reads or drops the summary; \`fresh\` starts a new session and keeps the transcript; \`settings propose compaction.micro\`.

## Memory and the nightly tidy
Each agent's memory is plain Markdown (MEMORY.md and topic files) in its own folder. The Memory page holds every agent's files, the shared memory every agent reads, notes about the person and a journal of every change with undo. Each night between 01:00 and 05:00 memory is tidied: lines ending "(until YYYY-MM-DD)" go after that day, and the agent's engine merges and trims; a whole night undoes at once. Where: Memory (\`memory\`); Settings, Behaviour, Tidy memory every night (\`behaviour\`); notes they kept in Settings, About you (\`about-you\`). You: \`memory\` for your own; \`note\` suggests a fact for them to keep or not; \`settings propose memory.tidy\`. Only the person: the shared memory, keeping notes.

## Recall
Before a turn, an agent brings up what is relevant from its other conversations and says exactly what it was given. Its own search reaches its conversations, the rooms it is in and its memory. Where: Settings, Behaviour, Bring up other conversations (\`behaviour\`). You: \`recall <words>\`; \`settings propose recall.beforeTurn\`.

## Approvals and rules
Ask first, Accept edits, Auto (only rules refuse) or Full access, which takes the engines' own guards off. A card shows the command, file, diff or page and blocks the turn. Rules are sentences; a deny beats an allow. Repeated approvals are offered as a rule, never for deleting, money or credentials. Work somebody else started never runs in Full access. Where: Settings, Rules and approvals (\`rules\`); new agents' start in Settings, New agents (\`new-agents\`). Only the person, always.

## Agents working with agents
\`say\` hands work to another agent; \`tab\` opens a conversation for it. A turn may make twelve changes, plus one message kept back to report. Each message an agent sends starts one step further along a chain; past the limit (twelve by default, 1 to 50) the words are held for the person. A budget across tasks is off unless they set one. Where: Settings, Behaviour, Agent-to-agent limit (\`behaviour\`). Only the person changes these.

## Rooms and Auto
In a room agents take turns and the lead speaks last. Who answers a message naming nobody: everyone, the lead, or Auto, where a small model picks the member whose role fits and the lead answers when it is unsure; @Name always wins. A room can be carried into Slack, Discord, WhatsApp or a Signal group. Where: the room's own settings; the engine Auto asks in Settings, Behaviour, Auto picks with (\`behaviour\`). You: \`room\`, \`say <room-id>\`, \`history\`.

## The incident desk
Something that fails for good goes to its lead, which retries once, hands it on or tells the person on a card. Where: Settings, Behaviour, Incident desk and Who leads incidents (\`behaviour\`). You: \`incident\` when you lead.

## Routines, check-ins and watchers
A routine runs at a time on chosen days, or once; a check-in every 15 minutes to 24 hours within hours, answering QUIET when nothing needs the person. A watcher looks at a folder, a page, a feed, a command or a place and starts a turn on a change, at most six an hour. An app watcher starts work on an event in a connected app (it needs the Composio project key in \`apps\`); an agent only proposes one, and the event reaches it as data. Where: Automations on the rail (\`automations\`), Schedules (\`automations:schedules\`) and Watchers (\`automations:watchers\`). You: \`routine\`, \`routines\`, \`unroutine\`, \`watch\`, \`watchers\`, \`edit-watch\`, \`unwatch\`, \`watch-app\`, \`app-events\`. Only the person: starting an app watcher.

## Intents, workflows, webhooks and jobs
An intent is up to twelve phrases; when one comes up in a conversation it posts a note, brings an agent in or messages one. Agents propose, the person approves. A workflow is a trigger, steps and a person who says yes; a webhook turns an outside event into a task; the job board holds work for whoever takes it. Where: Automations, Intents (\`automations:intents\`), Workflows (\`automations:workflows\`), Webhooks (\`automations:webhooks\`), Job board (\`automations:jobs\`). You: \`intent\`, \`intents\`, \`unintent\`, \`post\`, \`jobs\`. Only the person: approving intents, workflows, webhooks.

## Goals
\`/goal\` in the chat gives a conversation a goal: what done looks like, a check that must exit 0, and up to a hundred turns (twenty unless said). It keeps going until done, stuck or out of turns. You: \`goal\` reads it. Only the person sets, pauses or clears one.

## The morning brief
On Overview, written each morning from what is on disk, with no model call: what each agent did, what waits on the person and what it cost. They choose the time, the notification, whether a quiet morning notifies, and the sections. Where: Overview (\`overview\`), Customize the brief. You: \`settings propose\` brief.enabled, brief.time, brief.notify, brief.allClear, brief.section.<name>.

## Skills and their versions
Skills are instructions agents pick up. With suggestions on, Bloks offers a new skill after a turn that worked something out, or a change after a skill was corrected. Every version is kept: who, why, compare, restore. Where: Plugins, Skills (\`plugins:skills\`); Settings, Behaviour, Suggest skills (\`behaviour\`); Settings, Plugins (\`plugins\`). You: \`skills\`, \`skill\`, \`skill revise\` (a proposal); \`settings propose skills.learn\`. Only the person: keeping, editing, restoring, installing.

## The catalogue
Ready teams and skills, installed only after a review that names what each creates; routines start paused. Where: Plugins, Catalogue (\`plugins:catalog\`). Only the person installs.

## Engines and keys
Each agent picks an engine. Engines that run a program (Claude Code, Codex, Gemini CLI and others) work in folders; API engines get a smaller set of tools from Bloks. A backup engine takes a turn that hit a limit or outage. Engines and keys belong to a workspace. Where: Settings, Engines and keys (\`engines\`); an agent's engine in its settings (\`agent\`); defaults in Settings, New agents (\`new-agents\`); voices in Settings, Voices (\`voices\`). You: \`pause\` your own engine up to a day; \`settings propose agent.model\`, \`agent.effort\`, \`newAgents.effort\`. Only the person: installing, signing in, keys, endpoints.

## Bloks AI, plan and spending
Bloks AI is a monthly allowance on their Bloks plan: no key or sign-in. Usage shows cost, tokens and turns by agent and engine; a monthly spending limit on an engine with their own key pauses new turns there, or hands them to a backup. Members have limits of their own. Where: Settings, Plan (\`plan\`); Usage (\`usage\`); Members (\`workspace:members\`). Only the person.

## Apps, tools and secrets
Connected apps and MCP servers, and Composio's keys, saved secrets and using Bloks from other AI apps. Where: Settings, Plugins (\`plugins\`); Settings, Apps and keys (\`apps\`); Plugins on the rail (\`plugins:apps\`). You: \`secret\` asks for a key through a secure field. Only the person: everything else.

## Phones, the web and Bloks Cloud
The iPhone app pairs with each workspace; nothing runs on the phone. Location, when on, tells the owner's agents roughly where they are. With Bloks Cloud a workspace is reachable online for the phone, bloks.dev/web and people they invite, and each agent gets an email address. Where: Settings, Phone and devices (\`devices\`); Reachable online (\`workspace:online\`). You: \`location\`. Only the person: pairing, access, Cloud.

## Telegram, Signal, chat apps and email
Agents answer on Telegram or Signal; a room can be carried into Slack, Discord, WhatsApp or a Signal group; mail from anyone but the owner never runs in Full access. Where: Settings, Chat and email (\`chat\`). You: \`telegram\` sends a file to their chat with your bot; \`reply\` answers the group message that started a turn. Only the person sets these up.

## Home Assistant
Agents the owner let in read the entities the owner listed; a change asks on a card unless marked auto, and locks, alarms and garage doors always ask. Home Assistant can start an agent. Where: Settings, Home Assistant (\`home\`). You: \`home\`. Only the person sets it up.

## The browser, computers and where an agent works
The Bloks browser beside the chat is driven by agents while the person watches and can take over. Sites off their list ask first; passwords, card numbers and uploads always ask. A computer is a private VM here or in the cloud. An agent on an engine that runs a program can work in a Docker container or over SSH, set in its engine settings. Each agent has a terminal. Where: Settings, Browser (\`browser\`); Settings, Computers (\`computers\`); the agent's settings (\`agent\`). You: \`browser\`. Only the person: sites, computers, containers, SSH.

## Workspaces and people
A workspace is a whole Bloks with its own agents, memory, keys and folder. With Bloks Team they invite people as admins or members. Each workspace can be muted and says how much it may interrupt. Where: Settings, under the workspace's name: General (\`workspace:general\`), Members (\`workspace:members\`), Notifications (\`workspace:notifications\`). You: \`message-person\` when the owner or an admin asks. Only the person.

## Records, safety and moving
Consequential actions go in a signed, hash-chained record. The security checkup says what can reach their keys, accounts and computer. Backups are daily, beside the data folder, with undo history and a passphrase if chosen. Writing a workspace out moves it to an empty one elsewhere; keys never travel. Setups and past sessions come over from Claude Code, Codex and others, reviewed first. Export for training writes runs to a JSONL file here and sends nothing. Where: Settings, Record (\`record\`), Security checkup (\`security\`), Backups (\`backups\`), Bring your setup (\`bring-setup\`), Past conversations (\`past-sessions\`), Export for training (\`training\`). Only the person, all of it.

## Looks, language and updates
Name, theme, accent, transcript width, the sidebar's conversations, the quick ask shortcut and the language (seven; agents answer in whatever language is written to them, and some server words are English). Where: Settings, General (\`general\`); version, updates and feedback in Settings, About and updates (\`about\`). Only the person; theme, accent and width belong to each window.

## Where data lives
Plain files on their computer: Personal in ~/.bloks, other workspaces in the app's folder (on a Mac, ~/Library/Application Support/Bloks/workspaces/). Backups in ~/.bloks-backups, exports in ~/.bloks-exports. No server of Bloks holds their data.

Return: a plain answer in a few sentences: what it is, how it behaves, where it lives, and what you or they can do. Then \`open\` when a page helps.
Approval: none to explain or point. A proposed change waits on their Change.`,
  },
];

/** The design skill every agent that makes files has, attached or not:
 * a page an agent makes is the person's first look at its work, and the
 * defaults a model reaches for on its own (a gradient, white cards, a
 * wall of bullet points) look like nobody made them. */
export const PAGE_DESIGN = "page-design";

/** The same in a few lines, for an engine that cannot read the whole of
 * it on demand and would otherwise be sent all of it every turn. */
export const PAGE_DESIGN_SHORT = "Make it look finished: the answer first, a plain background (never a gradient), one accent color, system fonts, readable at phone width and in dark mode, everything in one file.";

/** An agent's attached skills, with the design skill added when it is not
 * among them. Read through the library, so a skill of the person's own
 * under the same id is the one that counts. */
export function withPageDesign(attached: Skill[]): Skill[] {
  if (attached.some((s) => s.id === PAGE_DESIGN)) return attached;
  const design = getSkills([PAGE_DESIGN]);
  return [...attached, ...design];
}

/** The skill on Bloks itself, which rides along as the design skill does,
 * for every agent whose turn has the command line to act with: told only
 * the commands, an agent asked for a new tab guessed, and a handoff landed
 * in a conversation nobody meant (GitHub 408). */
export const BLOKS_GUIDE = "using-bloks";

/** An agent's skills with the Bloks guide added when it is not among
 * them, read through the library so the person's own copy counts. */
export function withBloksGuide(attached: Skill[]): Skill[] {
  if (attached.some((s) => s.id === BLOKS_GUIDE)) return attached;
  return [...attached, ...getSkills([BLOKS_GUIDE])];
}

/** The skill on how Bloks works, feature by feature, and where each lives.
 * Explaining is harmless, so it goes to every turn that can read a skill
 * on demand. That is the turn the guide above goes to and no other:
 * reading one on demand is \`bloks skill\`, which needs the turn's own
 * full credential, and an API engine has no tool that reads a skill, so
 * sending it the index line would name a skill it cannot open. */
export const BLOKS_EXPLAINER = "how-bloks-works";

/** An agent's skills with the explainer added when it is not among them,
 * read through the library so the person's own copy counts. */
export function withBloksExplainer(attached: Skill[]): Skill[] {
  if (attached.some((s) => s.id === BLOKS_EXPLAINER)) return attached;
  return [...attached, ...getSkills([BLOKS_EXPLAINER])];
}

// ── reading ───────────────────────────────────────────────────────────

// Files already warned about, so a long skill is reported once rather
// than on every turn that lists the library.
const warnedLong = new Set<string>();

type ObservedSkill = Pick<Skill, "id" | "source"> & {
  name: string | null; description: string | null; version: string | null;
  body: boolean; registry: boolean; sha256: boolean;
  omitted: string[];
};
type SkillReadStatus = "complete" | "partial" | "unavailable";
let skillRead: SkillReadStatus = "unavailable";
let skillObservation: { observedAt: number; invalidatedAt: number | null; omittedItems: number; items: ObservedSkill[] } | null = null;
let skillReadAttempt: { at: number; status: SkillReadStatus } | null = null;

/** Metadata from this owner's natural reads only. Does not load a library,
 * read a file or claim that a hand-edited file is current. */
export function observedSkillLibrary() {
  return structuredClone({ lastObserved: skillObservation, lastAttempt: skillReadAttempt });
}

function readUserSkills(): Skill[] {
  skillRead = "complete";
  let entries: string[];
  try {
    entries = readdirSync(SKILLS_DIR);
  } catch (error) {
    skillRead = (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "complete" : "unavailable";
    return [];
  }
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const file = join(SKILLS_DIR, entry);
    try {
      // Opened once, as a regular file inside the folder: a skill is read
      // into every turn and shown to every device, so a link put here
      // that leads out of the folder is never followed, and the size
      // checked is the size of the bytes read.
      const held = openInside(SKILLS_DIR, [entry]);
      if (!held) throw new Error("not a file in the skills folder");
      if (held.stat.size > MAX_SKILL_FILE_BYTES) {
        closeHeld(held);
        skillRead = "partial";
        if (!warnedLong.has(file)) {
          warnedLong.add(file);
          console.warn(`[bloks] skipped skill ${entry}: the file is too large to read`);
        }
        continue;
      }
      const bytes = readHeld(held, MAX_SKILL_FILE_BYTES);
      if (!bytes) throw new Error("unreadable");
      const raw = bytes.toString("utf8");
      const parsed = parseMarkdown(raw);
      if (!parsed.body.trim()) continue;
      // Edited by hand past the limit. Still loaded, cut at the limit, but
      // said out loud so the missing tail is not a mystery.
      const length = countChars(parsed.body);
      let body = parsed.body;
      if (length > MAX_SKILL_CHARS) {
        body = [...body].slice(0, MAX_SKILL_CHARS).join("");
        if (!warnedLong.has(file)) {
          warnedLong.add(file);
          console.warn(
            `[bloks] skill ${entry} is ${length.toLocaleString("en-US")} characters; using the first ${MAX_SKILL_CHARS.toLocaleString("en-US")}`,
          );
        }
      }
      const id = slugify(entry.replace(/\.md$/, ""));
      skills.push({
        id,
        name: parsed.name?.trim() || nameFrom(parsed.body, id.replace(/-/g, " ")),
        description: parsed.description?.trim() || "",
        body,
        source: "user",
        ...(parsed.registry ? { registry: parsed.registry } : {}),
        ...(parsed.version ? { version: parsed.version } : {}),
        ...(parsed.sha256 ? { sha256: parsed.sha256 } : {}),
      });
    } catch {
      skillRead = "partial";
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
  const skills = [...builtin, ...user].sort((a, b) => a.name.localeCompare(b.name));
  const attempt = { at: Date.now(), status: skillRead };
  skillReadAttempt = attempt;
  if (skillRead === "complete") {
    const cap = MAX_USER_SKILLS + BUILTIN.length;
    skillObservation = {
      observedAt: attempt.at, invalidatedAt: null, omittedItems: Math.max(0, skills.length - cap),
      items: skills.slice(0, cap).map((s) => {
        const omitted: string[] = [];
        const text = (key: "name" | "description" | "version") => {
          const value = s[key];
          if (value === undefined) return null;
          if ([...value].length > 256) { omitted.push(key); return null; }
          return value;
        };
        return {
          id: s.id, name: text("name"), description: text("description"), version: text("version"), source: s.source,
          body: Boolean(s.body), registry: Boolean(s.registry), sha256: Boolean(s.sha256), omitted,
        };
      }),
    };
  }
  return skills;
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

/** Who is changing a skill, and why, for its history. */
export interface Change {
  by: Author;
  /** One line. */
  why: string;
  /**
   * The version the writer read. When it is given and the skill has
   * moved on since, nothing is written: two writers that both read
   * version 3 cannot both turn it into their version 4. A built-in, and
   * a skill that is not there yet, are version 0.
   */
  from?: number;
  /** Set when this puts an earlier version back. */
  restoredFrom?: number;
}

/** A write refused because the skill moved on since the writer read it. */
export class SkillMovedOn extends Error {
  readonly status = 409;
  readonly read: number;
  readonly current: number;
  constructor(read: number, current: number) {
    super(`This skill has changed since version ${read}: it is version ${current} now. Read it again and make the change against that.`);
    this.read = read;
    this.current = current;
  }
}

/** A change nobody described, which is a person saving in the app. */
const BY_YOU: Change = { by: { kind: "person", name: "you" }, why: "Saved" };

let history: SkillHistory | null = null;

/** Where every skill's versions are kept. Made on first use, so reading
 * the library never touches the disk beyond the skills themselves. */
export function skillHistory(): SkillHistory {
  return (history ??= new SkillHistory(join(DATA_DIR, "skill-history")));
}

/** A bundled skill as it ships, whether or not a copy shadows it. */
export function builtinSkill(id: string): Skill | null {
  const found = BUILTIN.find((b) => b.id === id);
  return found ? { ...found, source: "builtin" } : null;
}

/**
 * The version a skill is at, as an agent reading it now would see it.
 *
 * A built-in is version 0: it is the same text on every install. A skill
 * of the person's with no record yet, which is every skill written before
 * versions existed, becomes version 1 here, as it stands.
 */
export function revisionOf(skill: Pick<Skill, "id" | "source" | "name" | "description" | "body">): number {
  if (skill.source === "builtin") return 0;
  return skillHistory().sync(skill.id, skill).n;
}

/** One version of a skill in full, or null when there is no such version.
 * Version 0 of a built-in is the text it ships with. */
export function skillAt(id: string, n: number): Revision | null {
  if (n === 0) {
    const shipped = builtinSkill(id);
    return shipped
      ? { n: 0, at: 0, by: { kind: "builtin", name: "Bloks" }, why: "As it ships with Bloks", name: shipped.name, description: shipped.description, body: shipped.body }
      : null;
  }
  return skillHistory().get(slugify(id), n);
}

/** Every skill of the person's given a version 1 if it has none, so the
 * first look at any skill's history finds it already there. Run once as
 * the server starts; reading the library never writes. */
export function migrateSkillHistory(): number {
  let started = 0;
  for (const skill of readUserSkills()) {
    try {
      if (!skillHistory().latest(skill.id)) started++;
      skillHistory().sync(skill.id, skill);
    } catch {
      /* one unreadable record should not stop the rest */
    }
  }
  return started;
}

export function installSkill(input: InstallInput, change: Change = BY_YOU): Skill & { revision: number } {
  const fromDoc = input.markdown ? parseMarkdown(input.markdown) : null;
  const body = (input.body ?? fromDoc?.body ?? "").trim();
  if (!body) throw Object.assign(new Error("a skill needs instructions"), { status: 400 });
  const length = countChars(body);
  if (length > MAX_SKILL_CHARS) {
    throw Object.assign(
      new Error(
        `this skill is ${length.toLocaleString("en-US")} characters; skills are limited to ${MAX_SKILL_CHARS.toLocaleString("en-US")}`,
      ),
      { status: 413 },
    );
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
  // Whatever stands now is kept before anything is written over it: a
  // skill with no record yet, or a file edited by hand since its last
  // version, becomes a version of its own first.
  const standing = before ? skillHistory().sync(id, before).n : 0;
  if (change.from !== undefined && change.from !== standing) throw new SkillMovedOn(change.from, standing);
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
  if (skillObservation) skillObservation.invalidatedAt = Date.now();
  // The first change to a built-in makes it the person's own copy, and
  // that copy's history starts with the text as it shipped, so "what did
  // I change" has an answer.
  const shipped = before ? null : builtinSkill(id);
  if (shipped) {
    const latest = skillHistory().latest(id);
    if (!latest || !sameText(latest, shipped)) {
      skillHistory().record(id, shipped, { by: { kind: "builtin", name: "Bloks" }, why: "As it ships with Bloks" });
    }
  }
  const revision = skillHistory().record(id, { name, description, body }, change);
  return {
    id,
    name,
    description,
    body,
    source: "user",
    ...(from.registry ? { registry: from.registry } : {}),
    ...(from.version ? { version: from.version } : {}),
    ...(from.sha256 ? { sha256: from.sha256 } : {}),
    revision: revision.n,
  };
}

export function deleteSkill(id: string): boolean {
  const slug = slugify(id);
  try {
    unlinkSync(join(SKILLS_DIR, `${slug}.md`));
    if (skillObservation) skillObservation.invalidatedAt = Date.now();
    // its versions stay: removing a skill is not forgetting what it said
    try {
      skillHistory().removed(slug);
    } catch {
      /* the skill is gone either way */
    }
    return true;
  } catch {
    return false;
  }
}
