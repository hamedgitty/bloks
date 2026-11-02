#!/usr/bin/env node
// The README screenshots, made the same way every time.
//
//   pnpm screenshots                       every picture
//   pnpm screenshots --only=hero,usage     some of them, by name
//   pnpm screenshots --keep                leave the throwaway home behind
//
// Why this exists: the shots in docs/screenshots are the first thing
// anybody sees, and hand-made ones drift. The sidebar grew three items
// and the palette changed underneath the old set, and nobody noticed
// until the README was read next to the running app.
//
// What it does: builds the app, writes three made-up workspaces into a
// throwaway home (Personal, Brightwater with people in it, and one more
// for the switcher to list), starts the real desktop app on them in an
// invisible window (scripts/screenshot-kit.mjs), plays a few real turns
// through a stand-in engine so the cards, the answers and the memory
// journal are the app's own, and photographs each place.
//
// Decisions worth keeping:
//
//   Retina. Twice the window's size in pixels, which is what GitHub is
//   read at. A 1x capture scaled up looks worse than the one it replaces.
//
//   Made up, all of it. The people, the companies, the money and the
//   folders are invented, and the transcripts are written here by hand,
//   so a picture is reproducible and never depends on what a model said
//   that day or on what is in the maintainer's own install.
//
//   Today, in one timezone. The conversations happen this morning and the
//   usage over the last few weeks, so the brief, the charts and "Today"
//   all agree, at hours a person keeps.
//
// The workspaces, the stand-in's answers and the scenes are exported, so
// another script can photograph the same app with a cast of its own.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  REPO,
  agent,
  click,
  freePort,
  launchDesktop,
  openMenu,
  rail,
  removeHome,
  settingsPage,
  settle,
  shoot,
  startStandInServices,
  tempHome,
  wait,
  writeStandIn,
  writeWorkspace,
} from "./screenshot-kit.mjs";

export const TZ = "America/New_York";
process.env.TZ = TZ;
const DAY = 86_400_000;
const MIN = 60_000;

/** This morning at nine, or yesterday's when this morning has not had
 * time to happen yet. */
export function morning() {
  const d = new Date();
  d.setHours(9, 0, 0, 0);
  if (Date.now() - d.getTime() < 3 * 3_600_000) d.setDate(d.getDate() - 1);
  return d.getTime();
}

export const localDate = (at) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** A share between 0 and 1 that varies by day and by name, the same on
 * every run. */
export function wobble(seed, day) {
  let h = 2166136261;
  for (const c of `${seed}:${day}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

/**
 * Daily usage for a few weeks back: each [agent, dollars a weekday] costs
 * about that, less at weekends and a little less the month before, so
 * the comparison reads like a real one. `provider` is the engine.
 */
export function usageFor(rows, { days = 64, provider = "claude", estimated = false, personId = null } = {}) {
  const out = [];
  for (let back = days - 1; back >= 0; back--) {
    const at = Date.now() - back * DAY;
    const day = localDate(at);
    const weekend = [0, 6].includes(new Date(at).getDay());
    const growth = back > 30 ? 0.88 : 1;
    for (const [bot, base] of rows) {
      const cost = Math.round(base * growth * (weekend ? 0.35 : 1) * (0.6 + wobble(bot.name, day)) * 100) / 100;
      const turns = Math.max(1, Math.round(cost * 9));
      out.push({
        date: day,
        botId: bot.id,
        provider,
        turns,
        input: turns * 21_000,
        output: turns * 1_100,
        cost,
        costKnown: true,
        ...(estimated ? { estimated: cost } : {}),
        ...(personId ? { personId } : {}),
      });
    }
  }
  return out;
}

/** An agent's MEMORY.md as it would have written it, when there are
 * `lines`, and topic files beside it by name. */
export function memoryFile(dir, bot, lines, topics = {}) {
  const folder = join(dir, "workspaces", bot.id);
  mkdirSync(join(folder, "memory"), { recursive: true });
  if (lines) writeFileSync(join(folder, "MEMORY.md"), `Notes I keep between conversations.\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`);
  for (const [name, text] of Object.entries(topics)) writeFileSync(join(folder, "memory", name), text);
}

// ── the cast ──────────────────────────────────────────────────────────

export const OWNER = "Elena Marsh";

/** Personal: a launch, run by six agents and the person who owns them. */
function personal(home, t0) {
  const lead = agent("Head of Marketing", "Owns growth and the story", { color: "purple", shape: "invader", seniority: 4 });
  const copy = agent("Landing Page Lead", "Owns landing page copy and structure", { color: "coral", shape: "burst" });
  const seo = agent("SEO Strategist", "Owns organic search", { color: "green", shape: "diamond" });
  const content = agent("Launch Content Writer", "Owns launch week content", { color: "yellow", shape: "bit" });
  const chief = agent("Chief of Staff", "Keeps the week on track", { color: "blue", shape: "star", seniority: 5 });
  const research = agent("Research Analyst", "Deep dives, tight briefs", {
    color: "cyan",
    shape: "cloud",
    modelSelection: { instanceId: "gemini", model: "gemini-3.8-flash" },
  });
  const site = join(home, "launch-site");
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, "README.md"), "# Launch site\n\nShip the page on Thursday.\nWrite the release notes.\n");
  writeFileSync(join(site, "index.html"), "<!doctype html>\n<title>Launch</title>\n<h1>Your agents. Your machine. Your data.</h1>\n");
  writeFileSync(join(site, "old-draft.txt"), "An older plan nobody reads.\n");
  for (const b of [lead, copy, seo, content]) b.cwd = site;

  let tick = 0;
  const at = () => t0 + tick++ * 6 * MIN;
  const you = (text) => ({ id: randomUUID(), role: "user", kind: "text", text, at: at() });
  const say = (from, text) => ({ id: randomUUID(), role: "bot", from: from.id, kind: "text", text, at: at() });
  const ran = (from, name) => ({ id: randomUUID(), role: "bot", from: from.id, kind: "activity", tool: { name, ok: true }, at: at() });

  const room = { id: randomUUID(), name: "Launch week", memberIds: [lead.id, copy.id, seo.id, content.id], leadId: lead.id, createdAt: t0 - 2 * DAY };
  const launch = [
    you("Put together the launch for Bloks. Positioning, landing page, SEO, and a week of content."),
    say(
      lead,
      "Positioning first, everything hangs off it.\n\nBloks is the desktop home for personal AI agents that run on your machine, not someone else's cloud. Tagline: your agents, your machine, your data.\n\nThe wedge is that every competitor needs your data to leave your machine and we don't. That is the campaign in one sentence, and it holds up under scrutiny.\n\n@Landing Page Lead take the page, @SEO Strategist take search, @Launch Content Writer take the week. Stay in your lane, I will review.",
    ),
    say(
      copy,
      "Landing page done, section by section.\n\nHero: Your agents. Your machine. Your data.\nSub: Bloks is the desktop home for personal AI agents. No account, no backend, no sync.\n\nProblem, how it works, proof, FAQ, CTA. The FAQ answers \"why not just use a cloud assistant\" head on rather than dodging it.\n\n@Head of Marketing ready for review. One thing I could not verify: whether we can claim zero outbound traffic without qualifying it.",
    ),
    ran(seo, "WebSearch"),
    say(
      seo,
      "SEO plan is in. Fifteen keyword targets with intent mapped, ordered by how winnable they are.\n\nWe own local-first AI agents, private AI assistant and data ownership outright; nobody is writing seriously about them. Four evergreen pillars that compound, kept separate from launch week so the calendar does not eat the library.",
    ),
    say(
      content,
      "Launch week calendar, with the posts written rather than just titled.\n\nMon Show HN and a founder thread. Tue the architecture post. Wed a demo of agents working in a room. Thu the privacy piece. Fri the roadmap.\n\n@Head of Marketing all five are drafted, not outlined.",
    ),
    say(
      lead,
      "@Landing Page Lead good instinct on the outbound claim, and you were right to flag it rather than ship it. Qualify it: nothing leaves your machine except what the engine you connected sends on your behalf.\n\n@Launch Content Writer the comparison table has latency and cost numbers with no benchmark behind them. Cut them or label them illustrative.\n\n@SEO Strategist no notes. Ship it.",
    ),
    say(copy, "Qualified and updated. The FAQ now says it in the same words so the page does not contradict itself.\n\n@Head of Marketing done."),
    say(content, "Numbers are out of the table, replaced with a qualitative comparison that does not need a benchmark to stand up.\n\n@Head of Marketing done."),
    say(
      lead,
      "That is the launch. Positioning, a page ready for a designer, an SEO plan with real targets, and five days of drafted content.\n\nOne thing still open for you: we are claiming a desktop app on a page with no download link. Either we ship the build this week or the page needs a waitlist. Your call, everything else is ready.",
    ),
  ];
  const solo = (lines) => lines.map(([who, text], i) => ({ id: randomUUID(), role: who === "you" ? "user" : "bot", kind: "text", text, at: t0 + 80 * MIN + i * 3 * MIN }));
  const transcripts = {
    [room.id]: launch,
    [chief.threadId]: solo([
      ["you", "What needs me today?"],
      ["bot", "Three things. The launch room is waiting on your call about the download link. Payroll cutoff is Thursday. And the design review moved to 4pm, I already told them yes."],
    ]),
    [research.threadId]: solo([
      ["you", "Who else is building local-first agent apps?"],
      ["bot", "Six worth knowing. Two are serious, three are wrappers, one shut down last month. The short version: nobody has shipped multi-agent rooms, which is the part you should lead with."],
    ]),
    [lead.threadId]: solo([
      ["you", "How did the launch work land?"],
      ["bot", "Solid. I sent the comparison table back once for unbenchmarked numbers and it came back clean. The page still claims a desktop app with nothing to download, which is the only thing I would not ship as is."],
    ]),
    [seo.threadId]: solo([
      ["you", "Which three keywords first?"],
      ["bot", "Local-first AI agents, private AI assistant, and AI agents on my own computer. All three are winnable this quarter, and the first already sends us traffic."],
    ]),
    [content.threadId]: solo([
      ["you", "Is Thursday's privacy post ready?"],
      ["bot", "Drafted and fact-checked. It says what leaves your machine and what does not, with no claim the app cannot back up."],
    ]),
  };

  const dir = join(home, ".bloks");
  return {
    dir,
    cast: { lead, copy, seo, content, chief, research },
    bots: [content, copy, seo, lead, research, chief],
    rooms: [room],
    transcripts,
    usage: [
      ...usageFor([[lead, 0.9], [copy, 1.3], [seo, 0.6], [content, 0.8], [chief, 0.7]]),
      // the key of your own, priced from its tokens, close to its limit
      ...usageFor([[research, 1.75]], { provider: "gemini", estimated: true }),
    ],
    memories: () => {
      memoryFile(dir, chief, ["Payroll cutoff is Thursday", "Design review is at 4pm on Tuesdays", "Elena wants a short list, not a report"]);
      memoryFile(dir, seo, ["Targets: local-first AI agents, private AI assistant", "Pillar posts stay out of launch week"]);
      memoryFile(dir, research, ["Six competitors tracked; two are serious", "Lead with multi-agent rooms"]);
      memoryFile(dir, lead, null, {
        "launch-week.md": "# Launch week\n\n- Mon: Show HN and a founder thread\n- Tue: the architecture post\n- Wed: a demo of agents in a room\n- Thu: the privacy piece\n- Fri: the roadmap\n",
        "positioning.md": "# Positioning\n\nYour agents, your machine, your data.\nQualify every privacy claim: the engine you connect still sees what you send it.\n",
      });
    },
    config: {
      providers: { gemini: { key: "AIza-demo-key-for-screenshots-only" } },
      spendLimits: { gemini: 40 },
    },
    roles: {
      room: "Launch week",
      changes: { agent: copy.name, ask: "Please tidy the launch site folder before Friday.", reply: "Tidied the launch site" },
      answer: { agent: chief.name, ask: "How did each launch channel do last week?", reply: "Search did the heavy lifting", last: "Why did social convert less?" },
      remember: { agent: lead.name, ask: "Please remember: launch copy stays under 20 words a line, and launch day is Friday." },
      notice: research.name,
      terminal: copy.name,
      memory: lead.name,
      settings: "Engines and keys",
    },
  };
}

/** Brightwater: a small studio, two people in it, one more asking to join. */
export function brightwater(dir, t0) {
  const manager = agent("Studio Manager", "Runs the week and the room", { color: "green", shape: "star", seniority: 4 });
  const books = agent("Bookkeeper", "Invoices, budgets, the monthly close", { color: "orange", shape: "diamond" });
  const care = agent("Client Care", "Answers clients the same day", { color: "pink", shape: "cloud" });
  const priya = { id: "p_priya", name: "Priya Nair", role: "admin", createdAt: t0 - 40 * DAY, joinedAt: t0 - 40 * DAY, invitedBy: "owner", device: "iphone" };
  const tom = { id: "p_tom", name: "Tom Becker", role: "member", createdAt: t0 - 12 * DAY, joinedAt: t0 - 12 * DAY, invitedBy: "owner", device: "mac" };

  let tick = 0;
  const at = () => t0 + 20 * MIN + tick++ * 4 * MIN;
  const me = (text) => ({ id: randomUUID(), role: "user", kind: "text", text, at: at() });
  const by = (person, text) => ({ id: randomUUID(), role: "user", author: person.id, kind: "text", text, at: at() });
  const bot = (from, text) => ({ id: randomUUID(), role: "bot", from: from.id, kind: "text", text, at: at() });
  const room = { id: randomUUID(), name: "Spring collection", memberIds: [manager.id, books.id, care.id], leadId: manager.id, createdAt: t0 - 9 * DAY };
  const talk = [
    me("Morning all. Can we have the spring collection page live by Friday?"),
    by(priya, "Photos from the shoot are in the shared folder. @Studio Manager can you pull a shot list from them?"),
    bot(manager, "Shot list is ready: 14 photos, three of them need retouching. I flagged those three for Tom."),
    by(tom, "On it. The retouched three by tomorrow at noon."),
    bot(books, "Budget check: the shoot came in at $1,240, under the $1,500 we set aside."),
    me("Great. @Client Care draft the email to the wholesale list, please."),
    bot(care, "Draft is ready for a look: \"Spring is here at Brightwater\", with the six pieces stockists ask about most."),
  ];
  const usage = [
    ...usageFor([[manager, 1.1], [books, 0.4], [care, 0.6]], { days: 20 }),
    ...usageFor([[manager, 0.5], [care, 0.3]], { days: 20, personId: priya.id }),
    ...usageFor([[manager, 0.2]], { days: 12, personId: tom.id }),
  ];
  return {
    dir,
    cast: { manager, books, care, priya, tom },
    bots: [care, books, manager],
    rooms: [room],
    transcripts: { [room.id]: talk },
    files: {
      // what it is called on invites, as the app tells it
      "workspace.json": { name: "Brightwater", mark: { color: "#3E5BD9", pattern: "111101111" }, kind: "business" },
      "people.json": { version: 3, people: [priya, tom], memberships: [], invites: [], knocks: [] },
      "reads.json": {
        version: 1,
        threads: {
          [room.id]: {
            [priya.id]: { messageId: talk[6].id, at: talk[6].at + 2 * MIN },
            [tom.id]: { messageId: talk[4].id, at: talk[4].at + MIN },
          },
        },
      },
      "usage.json": usage,
      "owner-plan.json": { plan: "team" },
    },
    roles: { team: "ws_brightwater", teamRoom: "Spring collection", joiner: "Sam", joinerFull: "Sam Okafor" },
  };
}

// What the stand-in engine says, by what it is asked.
export const ENGINE_SCENES = [
  {
    match: "tidy",
    text: "Tidied the launch site: rewrote the README for Friday, started notes.md with the open questions, and removed the old draft.",
    files: {
      "README.md": "# Launch site\n\nShip the page on Friday.\nWrite the release notes.\nTell the beta list.\n",
      "notes.md": "Open questions\n- Pricing page copy\n- Who writes the changelog\n",
      "old-draft.txt": null,
    },
    cost: 0.21,
    limits: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.34 }, seven_day: { utilization: 0.71 } } },
  },
  {
    match: "channel",
    text: [
      "Search did the heavy lifting last week, and the newsletter converts best for what it costs.",
      "",
      "```openui",
      "root = Card([head, visits, signups, rate, chart, table, next])",
      'head = CardHeader("Launch week, by channel", "Monday to Sunday")',
      'visits = MetricIndicator("Visits", "18,420", "+32% on the week before", "up")',
      'signups = MetricIndicator("Signups", "1,136", "+21%", "up")',
      'rate = MetricIndicator("Conversion", "6.2%", "-0.5 pts", "down")',
      'chart = BarChart(["Search", "Newsletter", "Social", "Referral", "Direct"], [Series("Signups", [390, 340, 170, 96, 140])])',
      'table = Table([Col("Channel", ["Search", "Newsletter", "Social", "Referral", "Direct"]), Col("Visits", [6900, 3100, 4200, 1700, 2520]), Col("Signups", [390, 340, 170, 96, 140]), Col("Conversion", ["5.7%", "11.0%", "4.0%", "5.6%", "5.6%"])])',
      'next = FollowUpBlock([FollowUpItem("Plan next week around the newsletter"), FollowUpItem("Why did social convert less?")])',
      "```",
    ].join("\n"),
    cost: 0.09,
  },
  {
    match: "remember",
    text: "Noted. I will keep that in mind for every launch from now on.",
    memory: "Notes I keep between conversations.\n\n- Elena wants launch copy under 20 words a line\n- Launch day is Friday\n- Claims about privacy are qualified, never absolute\n",
    cost: 0.03,
  },
];

// ── the world ─────────────────────────────────────────────────────────

const LICENCE = `blok_live_${"5e2d".repeat(8)}`;

/**
 * Writes the workspaces and starts the app on them. `cast` makes
 * Personal's folder and says who plays which part (personal() above is
 * the README's); everything else is shared.
 */
export async function buildWorld({ size = { width: 1360, height: 880 }, cast = personal, scenes = ENGINE_SCENES, lan = false, personalOnline = true, tag = "readme" } = {}) {
  const home = tempHome(tag);
  const t0 = morning();
  const services = await startStandInServices({
    account: {
      plan: "team",
      interval: "year",
      status: "active",
      renewsAt: Date.now() + 211 * DAY,
      since: Date.now() - 154 * DAY,
      email: "e••••@brightwater.example",
      bloksAi: { active: true, renewsAt: Date.now() + 11 * DAY },
      sharedRoom: true,
    },
    offers: [],
    team: true,
    ai: {
      plan: "Bloks Team",
      usedPercent: 38,
      leftPercent: 62,
      monthlyLeftPercent: 62,
      renewsAt: Date.now() + 11 * DAY,
      team: true,
      usedTodayPercent: 4,
      dailyLimitPercent: 10,
      dailyResetsAt: new Date().setHours(24, 0, 0, 0),
    },
  });
  const ports = { personal: await freePort(), ws_brightwater: await freePort(), ws_maple: await freePort() };
  const engine = writeStandIn(home, scenes);
  const online = (port) => ({
    profile: { name: OWNER },
    instances: { claude: { driver: "claudeAgent", config: { cli: engine } } },
    credits: { licence: LICENCE },
    relay: { enabled: true, url: services.url, agentToken: `agent-${port}`, clientToken: `client-${port}` },
    remote: { enabled: true },
  });

  const p = cast(home, t0);
  const base = online(ports.personal);
  writeWorkspace(p.dir, {
    bots: p.bots,
    rooms: p.rooms,
    transcripts: p.transcripts,
    config: { ...base, ...(personalOnline ? {} : { remote: { enabled: false } }), ...p.config },
    files: { "usage.json": p.usage, ...(p.files ?? {}) },
  });
  p.memories?.();
  const b = brightwater(join(home, "app", "workspaces", "ws_brightwater"), t0);
  writeWorkspace(b.dir, { bots: b.bots, rooms: b.rooms, transcripts: b.transcripts, config: online(ports.ws_brightwater), files: b.files });
  writeWorkspace(join(home, "app", "workspaces", "ws_maple"), {
    bots: [agent("Order Desk", "Wholesale orders and deliveries", { color: "orange", shape: "bit" })],
    config: { profile: { name: OWNER }, instances: { claude: { driver: "claudeAgent", config: { cli: engine } } } },
  });

  const launch = {
    home,
    services,
    ports,
    size,
    lan,
    ownerName: OWNER,
    tz: TZ,
    workspaces: [
      { id: "personal", kind: "personal", name: "Personal" },
      { id: "ws_brightwater", kind: "business", name: "Brightwater", team: true, members: 3 },
      { id: "ws_maple", kind: "custom", name: "Maple Street Bakery", mark: { color: "#E8664A", pattern: "101111101" } },
    ],
  };
  const desktop = await launchDesktop(launch);
  const world = { home, services, desktop, page: desktop.page, personal: p, brightwater: b, t0, roles: { ...p.roles, ...b.roles } };
  /** Quits the app and opens it again on the same folders, the way a
   * person does after a change that needs a restart. */
  world.relaunch = async (over = {}) => {
    await world.desktop.close();
    world.desktop = await launchDesktop({ ...launch, ...over });
    world.page = world.desktop.page;
  };
  return world;
}

/** The turns and requests that make each place worth photographing. */
export async function prepare(world) {
  const { desktop, roles } = world;
  const api = desktop.api;
  await desktop.up("personal");
  const { bots } = await api("personal", "/api/bots");
  const named = (name) => bots.find((b) => b.name === name);
  const turn = async (name, text, kind) => {
    const bot = named(name);
    // in its first conversation, whichever one it was last left on
    const general = bot.tasks[0].id;
    await api("personal", `/api/bots/${bot.id}/tasks/${general}/activate`, "POST");
    const before = (await api("personal", "/api/bots")).bots.find((x) => x.id === bot.id).messages.length;
    await api("personal", `/api/bots/${bot.id}/messages`, "POST", { text, taskId: general });
    // until this turn's own reply is in and the agent is idle again
    for (let i = 0; i < 120; i++) {
      const now = (await api("personal", "/api/bots")).bots.find((x) => x.id === bot.id);
      if (now && !now.busy && now.messages.slice(before).some((m) => m.role === "bot" && m.kind === kind)) return bot;
      await wait(250);
    }
    throw new Error(`no ${kind} from ${name}`);
  };
  await turn(roles.changes.agent, roles.changes.ask, "changes");
  await turn(roles.answer.agent, roles.answer.ask, "text");
  const lead = await turn(roles.remember.agent, roles.remember.ask, "text");
  // and one change made by hand, so the journal has both kinds
  const said = await api("personal", `/api/bots/${lead.id}/memory`);
  await api("personal", `/api/bots/${lead.id}/memory`, "PUT", { text: `${said.text ?? ""}- The beta list hears first, a day early\n` });
  await api("personal", "/api/memory/shared", "PUT", {
    text: "What every agent here should know.\n\n- The company is two people and six agents\n- Money questions go to Elena before anything is promised\n",
  });
  await api("personal", "/api/briefs", "POST");
  await desktop.up(roles.team);
}

/** Somebody asking to join, the way the app's own Join does it: their
 * computer looks the invite up and sends a sealed request. */
export async function askToJoin(world, inviteName, asName) {
  const { desktop, roles } = world;
  const list = await desktop.api(roles.team, "/api/workspace/members");
  const invite = list.invites.find((i) => i.name === inviteName);
  if (!invite) throw new Error(`no open invite for ${inviteName}`);
  const { JoinClient } = await import(pathToFileURL(join(REPO, "server", "join-client.ts")).href);
  const joiner = new JoinClient(() => world.services.url);
  const found = await joiner.lookup(`${invite.link.split("~")[0]}~127.0.0.1:${desktop.ports[roles.team]}`);
  if (!found.ok) throw new Error(`the invite did not open: ${found.error}`);
  const claimed = await joiner.claim(found.session, { name: asName });
  if (claimed?.ok === false) throw new Error(`the request did not go through: ${claimed.error}`);
}

// ── the pictures ──────────────────────────────────────────────────────

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Opens a conversation by its row in the sidebar, in its first lane
 * when it has a few. */
export async function open(page, name, lane = "General") {
  await rail(page, "Chat");
  await click(page, new RegExp(`^${escape(name)}`));
  await wait(1000);
  await click(page, new RegExp(`^${escape(lane)}$`)).catch(() => {});
  await wait(800);
}

/** The smallest region around everything whose words start with one of
 * `texts` (or matches a `css:` selector), in CSS pixels, with a margin. */
async function around(page, parts, pad = 24) {
  const box = await page.evaluate((parts) => {
    const rects = [];
    for (const part of parts) {
      let el;
      if (part.startsWith("css:")) el = document.querySelector(part.slice(4));
      else {
        const all = [...document.querySelectorAll("main *, [role=dialog] *")].filter((e) => (e.textContent || "").trim().startsWith(part) && e.getBoundingClientRect().height > 0);
        el = all[all.length - 1];
      }
      if (el) rects.push(el.getBoundingClientRect());
    }
    if (!rects.length) return null;
    return {
      left: Math.min(...rects.map((r) => r.left)),
      top: Math.min(...rects.map((r) => r.top)),
      right: Math.max(...rects.map((r) => r.right)),
      bottom: Math.max(...rects.map((r) => r.bottom)),
      vw: innerWidth,
      vh: innerHeight,
    };
  }, parts);
  if (!box) throw new Error(`nothing to frame for ${parts.join(", ")}`);
  const x = Math.max(0, Math.floor(box.left - pad));
  const y = Math.max(0, Math.floor(box.top - pad));
  return { x, y, width: Math.min(box.vw - x, Math.ceil(box.right - box.left + 2 * pad)), height: Math.min(box.vh - y, Math.ceil(box.bottom - box.top + 2 * pad)) };
}

/** The transcript column of the conversation on screen. */
const COLUMN = "main [class*='max-w-[var(--transcript-width']";

/** Scrolls whatever scrolls in the main area to its end, or its start. */
async function scrollMain(page, to = "end") {
  await page.evaluate((to) => {
    const scrollers = [...document.querySelectorAll("main *")].filter((e) => e.scrollHeight > e.clientHeight + 40 && ["auto", "scroll"].includes(getComputedStyle(e).overflowY));
    for (const s of scrollers) s.scrollTop = to === "end" ? s.scrollHeight : 0;
  }, to);
  await wait(600);
}

/** Leaves whatever is open for the chat, closing dialogs and menus, so a
 * page that tells its server things is never left open across a switch. */
async function home(page) {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape");
    await wait(250);
  }
  await rail(page, "Chat");
}

/**
 * Every picture, in the order they are taken (some depend on the one
 * before). Each takes the world and `file(name)`, the path a picture of
 * that name is written to; a script that wants a different set of names
 * or a different folder passes its own.
 */
export const SCENES = {
  async hero({ desktop, page, roles }, file) {
    for (const dark of [false, true]) {
      await desktop.show("personal");
      await desktop.theme(dark ? "dark" : "light");
      await open(page, roles.room);
      await scrollMain(page);
      await settle(page);
      await shoot(page, file(dark ? "hero-dark" : "hero"));
    }
    await desktop.theme("light");
  },

  async changes({ page, roles }, file) {
    await open(page, roles.changes.agent);
    await click(page, /^Worked/);
    await settle(page);
    await shoot(page, file("changes-card"), { clip: await around(page, [roles.changes.ask, "css:[data-changes-card]", roles.changes.reply]) });
  },

  async answer({ desktop, page, roles }, file) {
    // tall enough for the whole answer, as far as a screen allows
    await desktop.resize({ width: 1360, height: 1060 });
    await open(page, roles.answer.agent);
    await scrollMain(page);
    await settle(page);
    await shoot(page, file("answer"), { clip: await around(page, [roles.answer.ask, roles.answer.reply, roles.answer.last]) });
    await desktop.resize(desktop.size);
  },

  async notice({ page, roles }, file) {
    await open(page, roles.notice);
    await settle(page);
    // the message box with its notice, and the line under it
    const composer = page.locator("main textarea").last().locator("xpath=ancestor::div[contains(@class, 'mx-auto')][1]");
    await shoot(page, file("usage-notice"), { element: composer, pad: 20 });
  },

  async terminal({ page, roles }, file) {
    await open(page, roles.terminal);
    await page.evaluate(() => localStorage.setItem("bloks-terminal-layout", JSON.stringify({ position: "bottom", arrangement: "docked", sizes: { left: 440, right: 440, top: 260, bottom: 300 }, split: 0.5 })));
    await page.reload({ waitUntil: "networkidle" });
    await wait(1500);
    await click(page, /^Terminal$/);
    await wait(2500);
    for (const line of ["ls", "cat notes.md"]) {
      await page.keyboard.type(line, { delay: 20 });
      await page.keyboard.press("Enter");
      await wait(700);
    }
    await settle(page);
    await shoot(page, file("terminal"));
    // the same shells, beside the chat, with a second one open
    await click(page, /^New terminal tab$/);
    await wait(1500);
    await page.keyboard.type("cat README.md", { delay: 20 });
    await page.keyboard.press("Enter");
    await wait(700);
    await openMenu(page, /^Terminal layout$/);
    await click(page, /^Move to the right$/);
    await openMenu(page, /^Terminal layout$/);
    await click(page, /^Side by side with the chat$/);
    await wait(1200);
    await settle(page);
    await shoot(page, file("terminal-split"));
    await click(page, /^Hide the terminal/);
  },

  async memory({ page, roles }, file) {
    await rail(page, "Memory");
    await click(page, new RegExp(`^${escape(roles.memory)}`));
    await wait(1200);
    // its topic files, and the journal of who changed what under them
    await page.evaluate(() =>
      [...document.querySelectorAll("main *")]
        .find((e) => e.children.length === 0 && (e.textContent || "").trim() === "Topics")
        ?.scrollIntoView({ block: "start" }),
    );
    await settle(page);
    await shoot(page, file("memory"));
  },

  async overview({ page }, file) {
    await rail(page, "Overview");
    await wait(1200);
    await settle(page);
    await shoot(page, file("overview"));
  },

  async usage({ desktop, page }, file) {
    await rail(page, "Usage");
    await wait(2000);
    await settle(page);
    await shoot(page, file("usage"));
    // tall enough for all of Limits, as far as a screen allows
    await desktop.resize({ width: desktop.size.width, height: 1060 });
    await page.evaluate(() => [...document.querySelectorAll("main h2, main h3, main div")].find((e) => (e.textContent || "").trim() === "Limits")?.scrollIntoView({ block: "start" }));
    await settle(page);
    await shoot(page, file("usage-limits"), { clip: await around(page, ["Limits", "Spending limits", "Estimated from tokens"], 28) });
    await desktop.resize(desktop.size);
  },

  async settings({ page, roles }, file) {
    await settingsPage(page, roles.settings ?? "General");
    await settle(page);
    await shoot(page, file("settings"));
  },

  async switcher({ page }, file) {
    await home(page);
    await openMenu(page, /switch workspace/);
    await settle(page, 500);
    await shoot(page, file("workspaces"), { clip: await around(page, ["css:[role=menu]"], 0).then((m) => ({ x: 0, y: 0, width: m.x + m.width + 140, height: m.y + m.height + 40 })) });
  },

  async newWorkspace({ page }, file) {
    await click(page, /^New workspace$/);
    await wait(900);
    await page.locator("[role=dialog] input").first().fill("Harbor Clinic");
    await click(page, /^Team$/, { within: "[role=dialog]" });
    await settle(page, 500);
    await shoot(page, file("new-workspace"), { element: "[role=dialog]", pad: 28 });
    await home(page);
  },

  async invite(world, file) {
    const { desktop, page, roles } = world;
    await desktop.show(roles.team);
    await settingsPage(page, "Members");
    await click(page, /^Invite someone$/);
    await wait(1500);
    await page.keyboard.type(roles.joiner, { delay: 30 });
    await wait(1200);
    await settle(page, 400);
    await shoot(page, file("invite"), { element: "[role=dialog]", pad: 28 });
    await click(page, /^Done$/, { within: "[role=dialog]" });
    // the person it was for asks to join with it
    await askToJoin(world, roles.joiner, roles.joinerFull);
    await wait(1500);
  },

  async members({ page }, file) {
    await page.reload({ waitUntil: "networkidle" });
    await wait(1500);
    await settingsPage(page, "Members");
    await wait(1200);
    await settle(page);
    await shoot(page, file("members"));
  },

  async plan({ page }, file) {
    await settingsPage(page, "Plan");
    await wait(2500);
    await settle(page);
    await shoot(page, file("plan"));
  },

  async people({ page, roles }, file) {
    await home(page);
    await open(page, roles.teamRoom);
    await scrollMain(page);
    // "Seen by" in words, the way a tap on the faces says it
    await page.evaluate(() => {
      for (const b of document.querySelectorAll('button[aria-label^="Seen by"]')) b.click();
    });
    await settle(page);
    await shoot(page, file("room-people"));
  },

  async join({ desktop, page, roles }, file) {
    await home(page);
    const { invite } = await desktop.api(roles.team, "/api/workspace/invites", "POST", { role: "member", name: "Ana" });
    await desktop.show("personal");
    await openMenu(page, /switch workspace/);
    await click(page, /^Join a workspace$/);
    await wait(900);
    await page.locator("[role=dialog] input").first().fill(invite.code);
    await page.keyboard.press("Enter");
    await wait(2500);
    await page.locator("[role=dialog] input").nth(1).fill("Ana Lopes");
    await settle(page, 400);
    await shoot(page, file("join"), { element: "[role=dialog]", pad: 28 });
    await home(page);
  },
};

// ── running it ────────────────────────────────────────────────────────

async function main() {
  const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);
  const out = join(REPO, "docs", "screenshots");
  execFileSync("pnpm", ["--config.verify-deps-before-run=false", "build"], { cwd: REPO, stdio: "pipe" });
  const world = await buildWorld();
  try {
    await prepare(world);
    for (const [name, scene] of Object.entries(SCENES)) {
      if (only.length && !only.includes(name)) continue;
      await scene(world, (n) => join(out, `${n}.png`));
    }
  } finally {
    await world.desktop.close();
    await world.services.close();
    if (!process.argv.includes("--keep")) removeHome(world.home);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
