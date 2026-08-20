#!/usr/bin/env node
// Writes a small, believable workspace into a throwaway BLOKS home so the
// README screenshots show the product rather than whatever happened to be
// in the maintainer's install.
//
//   node scripts/seed-demo.mjs /tmp/bloks-demo
//
// Then point the harness at it:
//   HOME=/tmp/bloks-demo pnpm dev:server
//
// Nothing here calls a model. The transcript is written by hand, because
// a screenshot should be reproducible and should not depend on what a
// provider felt like saying that day.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const home = process.argv[2];
if (!home) {
  console.error("usage: node scripts/seed-demo.mjs <home-dir>");
  process.exit(1);
}
const dir = join(home, ".bloks");
mkdirSync(dir, { recursive: true, mode: 0o700 });

const HOUR = 3_600_000;
const base = Date.parse("2026-03-17T09:00:00Z");
let tick = 0;
const at = () => base + tick++ * 4 * 60_000;

const agent = (name, title, over = {}) => ({
  id: randomUUID(),
  threadId: randomUUID(),
  name,
  title,
  description: "",
  notifications: true,
  unread: false,
  modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
  resumeCursors: {},
  createdAt: base - 48 * HOUR,
  ...over,
});

const lead = agent("Head of Marketing", "Owns growth and the story", {
  color: "purple",
  shape: "invader",
  seniority: 4,
});
const copy = agent("Landing Page Lead", "Owns landing page copy and structure", {
  color: "coral",
  shape: "burst",
  seniority: 1,
});
const seo = agent("SEO Strategist", "Owns organic search", { color: "green", shape: "diamond", seniority: 1 });
const content = agent("Launch Content Writer", "Owns launch week content", {
  color: "yellow",
  shape: "bit",
  seniority: 1,
});
const chief = agent("Chief of Staff", "Keeps the week on track", {
  color: "blue",
  shape: "star",
  seniority: 5,
});
const research = agent("Research Analyst", "Deep dives, tight briefs", {
  color: "cyan",
  shape: "cloud",
  seniority: 1,
});

const bots = [lead, copy, seo, content, chief, research];
writeFileSync(join(dir, "bots.json"), JSON.stringify(bots, null, 2), { mode: 0o600 });

const room = { id: randomUUID(), name: "Launch week", memberIds: [lead.id, copy.id, seo.id, content.id], createdAt: base - 2 * HOUR };
writeFileSync(join(dir, "bloks.json"), JSON.stringify([room], null, 2), { mode: 0o600 });

const say = (from, text) => ({ id: randomUUID(), role: "bot", from, kind: "text", text, at: at() });
const you = (text) => ({ id: randomUUID(), role: "user", kind: "text", text, at: at() });
const did = (from, name, ok) => ({ id: randomUUID(), role: "bot", from, kind: "activity", tool: { name, ok }, at: at() });

const transcript = [
  you("Put together the launch for Bloks. Positioning, landing page, SEO, and a week of content."),
  say(
    lead.id,
    "Positioning first, everything hangs off it.\n\nBloks is the desktop home for personal AI agents that run on your machine, not someone else's cloud. Tagline: your agents, your machine, your data.\n\nThe wedge is that every competitor needs your data to leave your machine and we don't. That is the campaign in one sentence, and it holds up under scrutiny, which matters for the audience that actually drives local-first adoption.\n\n@Landing Page Lead take the page, @SEO Strategist take search, @Launch Content Writer take the week. Stay in your lane, I will review.",
  ),
  say(
    copy.id,
    "Landing page done, section by section.\n\nHero: Your agents. Your machine. Your data.\nSub: Bloks is the desktop home for personal AI agents. No account, no backend, no sync.\n\nProblem, how it works, proof, FAQ, CTA. The FAQ answers \"why not just use a cloud assistant\" head on rather than dodging it.\n\n@Head of Marketing ready for review. One thing I could not verify: whether we can claim zero outbound traffic without qualifying it.",
  ),
  did(seo.id, "WebSearch", true),
  say(
    seo.id,
    "SEO plan is in. Fifteen keyword targets with intent mapped, ordered by how winnable they are.\n\nWe own local-first AI agents, private AI assistant and data ownership outright; nobody is writing seriously about them. Four evergreen pillars that compound, kept separate from launch week so the calendar does not eat the library.\n\n@Head of Marketing the technical checklist is short because the site is one page today. That changes the moment we add the pillars.",
  ),
  say(
    content.id,
    "Launch week calendar, with the posts written rather than just titled.\n\nMon Show HN and a founder thread. Tue the architecture post, which is the one the technical audience actually reads. Wed a demo of agents working in a room. Thu the privacy piece. Fri the roadmap.\n\n@Head of Marketing all five are drafted, not outlined.",
  ),
  say(
    lead.id,
    "@Landing Page Lead good instinct on the outbound claim, and you were right to flag it rather than ship it. Qualify it: nothing leaves your machine except what the engine you connected sends on your behalf. That is true and it is still the strongest sentence on the page.\n\n@Launch Content Writer the comparison table has latency and cost numbers with no benchmark behind them. Cut them or label them illustrative. Everything else holds.\n\n@SEO Strategist no notes. Ship it.",
  ),
  say(
    copy.id,
    "Qualified and updated. The FAQ now says it in the same words so the page does not contradict itself.\n\n@Head of Marketing done.",
  ),
  say(
    content.id,
    "Numbers are out of the table, replaced with the qualitative comparison that does not need a benchmark to stand up.\n\n@Head of Marketing done.",
  ),
  say(
    lead.id,
    "That is the launch. Positioning, a page ready for a designer, an SEO plan with real targets, and five days of drafted content.\n\nOne thing still open for you: we are claiming a desktop app on a page with no download link. Either we ship the build this week or the page needs a waitlist. Your call, everything else is ready.",
  ),
];
writeFileSync(join(dir, `messages-${room.id}.json`), JSON.stringify(transcript, null, 2), { mode: 0o600 });

// short solo threads so the sidebar previews read like a real workspace
const solo = {
  [chief.threadId]: [
    you("What needs me today?"),
    say(null, "Three things. The launch room is waiting on your call about the download link. Payroll cutoff is Thursday. And the design review moved to 4pm, I already told them yes."),
  ],
  [research.threadId]: [
    you("Who else is building local-first agent apps?"),
    say(null, "Six worth knowing. Two are serious, three are wrappers, one shut down last month. The short version: nobody has shipped multi-agent rooms, which is the part you should lead with."),
  ],
  [lead.threadId]: [
    you("How did the launch work land?"),
    say(null, "Solid. I sent the comparison table back once for unbenchmarked numbers and it came back clean. The page still claims a desktop app with nothing to download, which is the only thing I would not ship as is."),
  ],
  [copy.threadId]: [say(null, "Landing Page Lead here. Owns landing page copy and structure.")],
  [seo.threadId]: [say(null, "SEO Strategist here. Owns organic search.")],
  [content.threadId]: [say(null, "Launch Content Writer here. Owns launch week content.")],
};
for (const [threadId, messages] of Object.entries(solo)) {
  const own = messages.map((m) => ({ ...m, from: undefined }));
  writeFileSync(join(dir, `messages-${threadId}.json`), JSON.stringify(own, null, 2), { mode: 0o600 });
}

writeFileSync(join(dir, "config.json"), JSON.stringify({}, null, 2), { mode: 0o600 });
console.log(`seeded ${bots.length} agents and 1 room into ${dir}`);
