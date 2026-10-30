// What this server can do for a client on another device, by name.
//
// The phone comes from the App Store and this app updates itself, each on
// its own schedule, so either one can be ahead of the other. /api/health
// carries this list and the version beside it; a phone reads them and
// hides what this Mac cannot do yet, instead of offering a button whose
// answer is a 404 it has to explain.
//
// Names rather than version numbers, because a name means one thing
// however releases are numbered. The rules that keep it honest:
//
//   Add a name in the same change that adds what it names, for anything a
//   phone or another computer calls: a route, a field a route now reads,
//   an event the stream now sends.
//
//   Never take a name out while a phone build that asks for it could still
//   be in use. Removing what it names is a separate, later decision.
export const FEATURES: readonly string[] = [
  // PATCH section on agents and rooms, and the sidebar sections it files into
  "sections",
  // ?before= paging on a transcript, for loading earlier messages
  "earlier",
  // GET /api/bots/:id/exchange/:peer, one agent's messages with another
  "exchange",
  // voice calls: claim, renew, hang up
  "calls",
  // watchers: pages and feeds an agent keeps an eye on
  "watchers",
  // the daily brief and its settings
  "briefs",
  // scheduled work, made, changed and removed from a phone
  "routines",
  // incoming webhooks per agent
  "webhooks",
  // what your agents know about you
  "notes",
  // GET /api/plan-usage for a paired device, not only this machine
  "plan-usage",
  // GET /api/usage-notices?thread=: the notices in the composer about a
  // limit, from Bloks AI's own word or an engine's plan windows, worst
  // first, each { id, source, level, title, usedPercent, resetsAt }; and
  // usedTodayPercent, dailyLimitPercent and dailyResetsAt on GET /api/credits
  "usage-notices",
  // GET /api/usage/report?range=&bot=&engine=: the Usage page's numbers,
  // by day, agent and engine, with the span before for comparison
  "usage-report",
  // GET /api/spend-limits and PUT /api/spend-limits/:instance: a monthly
  // spending limit on an engine that runs on the person's own key, and
  // kind: "spend" on a usage notice about one
  "spend-limits",
  // GET and POST /api/threads/:t/messages/:id/redo: what redoing a
  // message the agent already read would take back, and doing it
  "redo",
  // reply.settled on the event stream: a turn's reply, said once when the
  // turn is over, which a desktop in remote mode waits for before it
  // stops announcing replies as they land
  "reply-settled",
  // the private settings-request frame an inspection puts on the owner's
  // stream, and POST /api/settings/device-report: a window's answer to it,
  // or a paired phone's own settings, also sent as it connects and when
  // one of them changes
  "device-settings",
  // POST /api/location: a paired phone's own place, and whether it is
  // sharing, on, paused or off, with whether it shares with the app closed;
  // GET and DELETE for the owner; the private location-request frame an
  // agent's --fresh puts on the owner's streams; and place watchers
  "location",
  // GET, POST and DELETE /api/engine-pauses: engines and models paused
  // for a while, and `waitsFor: "pause"` with `waitsUntil` on a message
  // held for one
  "engine-pauses",
  // codexText on a bot's text and joinedTurnId on the person's, in history
  // and on the stream: Codex narration another agent's turn produced, to
  // show as work and never alert for (shared/codex-text.d.ts)
  "codex-progress",
  // files shared into a conversation: names with folders in them, byte
  // ranges (?range= through Bloks Cloud), GET /api/artifacts/resolve for
  // a link that is a path, and video among the types a viewer opens
  "shared-files",
  // people on an agent's Telegram bot: personId and action (allow,
  // decline, remove) and discardPending on the Telegram route, people and
  // upgradeNotices in its status, tg-person: request ids on /respond, and
  // telegramPerson and telegramSent on messages. Without it a phone shows
  // every Telegram message as the owner's and offers no admission.
  "telegram-people",
  // POST /api/live-activities: a phone's Live Activity tokens, so this
  // computer can start an activity for the person's own turn and end it
  // while the phone sleeps
  "live-activities",
  // Codex speed: codex.speed on GET and PATCH /api/config, an agent's
  // codexSpeed on PATCH /api/bots/:id, and a running lane's codexDispatch
  "codex-speed",
  // GET and PUT /api/memory/shared, its journal and undo: one MEMORY.md the
  // person keeps for every agent, with memory.changed for botId "_shared"
  "shared-memory",
  // GET /api/memory/search?q=: every agent's memory and the shared memory
  "memory-search",
  // GET /api/bots/:id/memory/stats (lines and bytes against what a turn
  // loads, topics with sizes and times), and changedAt on each topic
  "memory-stats",
  // POST /api/bots/:id/memory/copy: topics and picked MEMORY.md lines from
  // another agent, journaled so the copy can be undone
  "memory-copy",
  // GET and POST /api/bots/:id/memory/tidy and POST .../tidy/:runId/undo:
  // the nightly memory tidy, its diary and Tidy now; memory.tidy on
  // /api/config; `memory` lines on a brief; "tidy" entries in the journal
  "memory-tidy",
  // GET, POST, PATCH and DELETE /api/intents: standing intents, approving
  // an agent's proposal, pausing and renewing; `intents` on the stream,
  // and `intent` with via "intent" on the messages they post and send
  "intents",
  // the incident desk: GET /api/incidents and /api/incidents/:id,
  // POST /api/incidents/:id/resolve and /retry, `incidents` on
  // GET /api/activity, on PUT /api/config and on a brief, an `incident`
  // on a notice for its card, and the `incidents` frame on the stream
  "incidents",
  // routines and watchers that stop running on their own after failing
  // three times in a row: `failures` and `failing` on each in
  // GET /api/routines and /api/watchers, cleared by any PATCH, `failing`
  // on a brief and on GET /api/activity, and `failing` on its notice
  "automation-failures",
  // Bloks credits: GET and PATCH /api/credits (the balance as the service
  // says it, the background switch, a refusal still standing, the checkout
  // address) and the `credits` frame on the stream. engineAccess is gone
  // from each agent: Claude Code runs on the person's own plan or key, and
  // PATCH /api/bots/:id refuses "credits" with a sentence to show
  "credits",
  // Bloks AI, which credits became: GET /api/credits says what is left
  // as shares of the plan (leftPercent, monthlyLeftPercent, topUps,
  // renewsAt, low, plan), never an amount, with `members` on a team plan
  // and `team` and `teamSignInWarning`; PATCH /api/credits takes
  // { memberCaps: { [member]: percent or null } } from the owner; the
  // Bloks engine has one model, "bloks-ai"
  "bloks-ai",
  // a hosted workspace: `hosted` on /api/health, `hosted` on /api/config
  // with the computer choices it offers, refusals with code "hosted", and
  // POST /api/hosted/desktop for a ticket to its virtual desktop
  "hosted",
  // the owner's name: profile.name on GET and PUT /api/config, the
  // `workspace.owner` frame to members when it changes, and code
  // "name_required" (409) on sharing a room or inviting anybody without one
  "owner-name",
  // an agent's own Telegram bot asked for on a secret card: `telegram` on
  // the card (the bot it names, and the one its token turned out to be
  // for), and a save that goes to that agent's Telegram settings
  "telegram-bot-card",
  // a person on an agent's Telegram bot the owner gave full access:
  // actions "full" and "restricted" on the Telegram route, `full` on each
  // person in its status, and telegramDelegate on the messages they send
  "telegram-full-access",
  // a raw GET through Bloks Cloud answered in parts: `parts`, `part` and
  // `tag` on the sealed request, `size`, `parts`, `part` and `tag` on each
  // answer, 412 for a file that changed between parts, 413 past 50 MB
  // (server/relay-link.ts, servePart); `openMaxBytes` on
  // GET /api/attachments/where for a caller through Bloks Cloud
  "raw-parts",
  // POST /api/viewing { viewer, threadId, seq }: what a window or a paired
  // phone has in front of the person, said again every thirty seconds
  // while it does and null when it stops; an answer the person was
  // waiting on wakes their phones (reason "reply", category "reply") only
  // while no client shows its conversation (server/answer-ready.ts)
  "viewing",
  // GET and PUT /api/workspace/attention { mute, notify }: the workspace's
  // mute (null, "forever" or when it ends) and notification level, which
  // an answer's wake keeps to, set by the owner from any device of theirs
  // and kept by this server across restarts (server/attention.ts)
  "attention",
  // watchers of kind "app": an event in a connected app starts a turn
  // (server/app-watch.ts). GET /api/app-triggers/:toolkit and its
  // /accounts, POST /api/watchers/:id/confirm and /decline for an agent's
  // proposal, `app` on each such watcher with its run history, and `apps`
  // on GET /api/watchers saying whether events can be heard
  "app-watchers",
  // POST /api/bots/:id/messages { stopFirst: true }: the person's stop and
  // send now in one request. The words go ahead of what already waits,
  // in a turn of their own, before the turn is stopped; the answer says
  // `stopped: true` when they wait for that turn to end (GitHub 452)
  "stop-send-first",
];
