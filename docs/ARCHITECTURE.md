# Architecture

Three pieces, one rule.

| Layer | Location | Responsibility |
| --- | --- | --- |
| React app | `src/` | Chat, rooms, agent roster, panels, avatars |
| Harness server | `server/` | HTTP API, one SSE stream, provider registry, persistence, approvals |
| Electron shell | `electron/` | macOS window, packaged server, speech and computer bridges |

**The client holds no transports.** The React app never opens a
connection to a model provider. It dispatches typed commands over HTTP
and folds a single server-sent event stream into reducer state. Every
provider process runs inside the harness.

Everything below follows from that.

## A turn, end to end

1. `StoreProvider` loads `/api/bots`, `/api/bloks`, `/api/instances`,
   `/api/providers` and `/api/config`, then opens `/api/events`.
2. You send a message. The client dispatches `send`, which POSTs to
   `/api/bots/:id/messages`.
3. `startTurn` in `server/index.ts` builds the persona (role, skills,
   your profile, house style, and in a room the roster plus recent
   transcript), photographs the agent's folder (`server/checkpoints.ts`),
   then calls the driver's `sendTurn`.
4. The driver translates its provider's native output into the canonical
   events in `server/contracts.ts`.
5. The bus subscriber folds those events into the transcript, persists
   them, and broadcasts to every connected client.
6. The reducer folds the same events into messages, streaming text, busy
   flags and approval cards.
7. On `turn.completed` the folder (or, for a rehearsal, its clone) is
   photographed again. If anything
   changed, a `changes` message lands under the reply, and
   `/api/checkpoints/:id/diff` and `/revert` serve its diff and its undo.

The canonical event stream is the source of truth. The persisted
transcript and every client view are projections of it.

## Drivers

A driver turns one provider into the contract in `server/contracts.ts`.
There are three shapes:

**CLI over a native protocol.** `claude.ts` and `codex.ts` drive their
official CLIs headless over the protocols those CLIs expose. They carry
tool calls and permission requests.

**CLI over the Agent Client Protocol.** `acp.ts` is generic: ACP is a
JSON-RPC protocol that agent CLIs speak so editors can drive them, so one
implementation serves any agent that speaks it. Gemini CLI is the first.
Adding another is an entry in `ACP_SPECS`.

**OpenAI-compatible HTTP.** `openai-compat.ts` is generic too. Nearly
every lab now answers `/chat/completions`, so providers are data in
`server/providers.ts` rather than code. These are transcript-replay: the
harness hands them the folded history each turn. They stream text but
they do not run tools.

The registry (`server/harness/registry.ts`) turns a config map into live
instances. An unknown driver or a bad config becomes an unavailable
shadow entry rather than a startup failure, so a config written by a
newer build downgrades safely.

## Rooms

A room is a transcript with several agents in it. Two things make it work
like a workspace rather than a group chat with echoes:

**One speaker at a time.** `postToRoom` runs members sequentially in
ascending seniority, so each one sees what the last actually said and the
most senior speaks last. Handoffs raised mid-round queue rather than
interrupting, then drain in further rounds, bounded by `MAX_AGENT_HOPS`.

**Sessions belong to agents, not rooms.** An agent's provider session is
keyed to its own thread id. `activeRoom` redirects that agent's events
into whichever room it is currently speaking in. That is why an agent
remembers a room conversation when you DM it afterwards.

Team formation (`server/teams.ts`) sits on top: a senior agent can emit a
fenced plan, which becomes an approval card. Only your yes creates the
agents and the room.

## Persistence

Plain JSON under `~/.bloks`, written synchronously. No database.

| Path | Contents |
| --- | --- |
| `bots.json` | Agent records, model selection, resume cursors |
| `bloks.json` | Rooms and members |
| `sidebar.json` | The order of the sidebar's section headings |
| `turns-in-flight.json` | Every turn while it runs, so one cut off by a stop is picked up |
| `room-lines.json` | Room lines waiting for a busy agent, or for Bloks to be back |
| `messages-<id>.json` | One transcript per agent or room, same key space |
| `config.json` | Connected providers and keys, `0600` |
| `skills/*.md` | Installed skills |
| `events/`, `native/` | Canonical events, and raw provider traffic |
| `checkpoints/` | Content-addressed file versions, one photograph per folder, and the undo records |

A store writes its whole file on every change. Where losing that file
would hurt (agents, transcripts, rooms, config and the like) the write
goes through `server/atomic-write.ts`: to a file beside it, flushed, then
renamed over the old one, so a crash leaves the old file or the new one,
never half. Such a file that is there and will not parse is moved aside
as `<name>.corrupt-<time>` before its store starts empty, so the next
save cannot write over the only copy.

Checkpoints are not git. On a Mac without the developer tools
`/usr/bin/git` is a stub that opens an installer, so the store hashes
files itself: each version is kept once by its sha256, a file whose size
and mtime have not moved is not read again, and regenerated folders
(`node_modules` and friends) are skipped. An undo restores a file only if
it is still exactly what the turn left behind.

Memory has its own journal (`server/memory-journal.ts`). An agent's
MEMORY.md and topic files are read before and after each turn, and any
difference becomes an entry with the whole text before and after, as do
edits made from the Memory panel. Undo follows the checkpoint rule: only
a file still exactly as that change left it goes back, and a file that
has become a link is never written through.

Room ids and agent thread ids share one key space, which is why a room
transcript and a solo transcript are the same kind of file.

## Clients that are not on this machine

The phone, a browser at bloks.dev/web, and the desktop app in remote mode
all reach a workspace the same way. Each is a paired device with its own
token; the workspace keeps only its sha256. Both ends derive one AES-GCM
key per direction from it (`server/relay-crypto.ts`), every request and
every event frame is sealed for one device, and the relay in between
carries ciphertext it cannot open. A browser keeps the two keys as
non-extractable WebCrypto keys and never the token. Routes that mint new
pairings answer only on this machine.

The line to the relay (`server/relay-link.ts`) is two things. The stream
in, which carries asks, is watched for silence and redialled. What goes
back out, answers and event frames, is its own health reading: an answer
is retried until the relay's 20 second wait is over (the relay settles an
ask once, so a repeat is harmless), and `delivering` drops when an answer
is lost or half the recent posts failed. Status shows green only when
both hold, because a lossy network can keep the stream open while every
reply goes nowhere.

The relay takes 2 MB a payload, and sealing grows an answer by about 1.8
times. So a request that arrives through it gets transcripts cut to their
newest part: `GET /api/bots`, `GET /api/bloks` and a lane switch each fit
in about 700 KB of messages, shared evenly so one long conversation cannot
starve the rest, and each transcript says how many `olderMessages` stayed
behind. `GET /api/bots/:id/messages?thread=&before=` and
`GET /api/bloks/:id/messages?before=` page back through them. Requests from
this machine or the same network are not cut. An answer that would still be
too big is replaced with a short 413, so the phone hears why instead of
waiting out the relay's timeout.

## Rehearsals

`server/rehearsals.ts` clones the agent's folder (copy-on-write with
`cp -c` on APFS, `--reflink=auto` on Linux, a plain copy elsewhere) and
runs the turn in a lane of its own pinned to the clone. The checkpoint is
taken between the real folder before and the clone after, so the card is
the same one undo uses, marked as a rehearsal. `/api/checkpoints/:id/apply`
writes each file only if the real one still matches what it was when the
rehearsal began, then the record undoes like any other; applying one
attempt of a compared task discards the rest. Copies are deleted when an
attempt is applied or discarded, and swept after a week.

## Rewind

`POST /api/threads/:lane/rewind` takes a lane back to before one of the
person's messages. It reverts the lane's checkpoints from that message
on, newest first, with the same rule as undo: a file whose current
content is not what the turn left is skipped and named. The message and
everything after it are marked `rewound` (and `deleted`, so no
transcript carries them), a context summary that covers any of them is
dropped, and the lane's engine cursors are cleared, so the next turn is
a fresh session that is replayed only what is left. Memory notes are not
touched; the memory journal has its own undo. Rooms and rehearsal lanes
refuse.

## Backup engines

`server/failover.ts` decides whether a failed turn failed because its
engine is out (a usage or rate limit, no credit, an outage, signed out)
rather than because of the work, from the turn's runtime errors and stop
reason, and when the engine should be usable again (an epoch, "try again
in 20m", "resets 3pm", or a default per reason, capped at twelve hours).
The engine rests in a per-instance table in memory, so every agent on it
skips it until then. An agent with a `backupSelection` has its failed
solo turn started again on the backup, once, with `fallback: true`; the
engine switch hands over the bounded story as any switch does (see
Compactions). The raw error is held back while a backup takes over and
shown if none does. Room turns do not retry, but the rest applies to
their next turn. A turn that answers ends a sign-in rest on its engine
early, since the login works again.

Other agents read the same facts the person sees
(`server/engine-readiness.ts`). With an agent's credential,
`GET /api/bots` gives each agent an `engine`: `ready`, `signedOut`, `out`
with `until` and `reason`, or `unavailable`, with the engine's name. It
comes from whether the instance is there and switched on, its rest, and
its own snapshot (installed, signed in), which is asked at most every half
minute; an agent whose own engine cannot answer and whose backup can is
ready. `bloks agents` lists it as ready, not signed in, out until a time,
or unavailable. A message from another agent to one that cannot answer is
still delivered, and the answer to the sender carries an `engine`
sentence saying why and who can fix it. No key, path or engine error is
part of either.

## Compactions

Claude Code compacts its own session when it fills, and says so with a
`compact_boundary` frame; the driver turns that into `context.compacted`,
which leaves a one-line marker in the conversation. Its numbers are the
lane's own request readings, not the engine's compaction metadata, which
counts differently: before is the last request the session made ahead of
the boundary, and after is the first one it makes once past it, patched
into the same marker when it comes (`store.beginCompaction` and
`resolveCompaction`). Until then the marker says only where it started
from, and the lane has no fill to show. A request from another engine,
model or session (a switch, a rewind, a new session after a resume that
failed) cancels the wait rather than completing it, and a subagent's own
boundary or usage never marks or measures the lane it works for. With
idle compaction on (Settings, off by default), a minute
timer in `server/index.ts` finds Claude Code lanes over 100k tokens whose
last request was 55 minutes ago, inside an hour's cache, and sends
`/compact` into the resumed session with the same tools and system prompt
as the lane's last turn, so it reads the cache rather than writing it
again (`idleCompactionDue` in `server/context.ts`). It runs as the lane's
turn, so anything said meanwhile queues, but nothing else a turn does
happens: no message in the person's name, no unread, no other agent or
room. Two run at a time, and a lane whose window has passed is skipped.

How full a lane is comes from the engine, not from the turn's token
total: `context.reading` events carry the latest request's size and the
window, which Claude Code gives per message (`promptSize`) and in its
result (`modelUsage[model].contextWindow`), Codex in
`thread/tokenUsage/updated` (`last.inputTokens` against
`modelContextWindow`), an ACP agent in `usage_update` (`used`, `size`),
and an OpenAI-compatible provider in each response's `prompt_tokens`, one
reading per request of a tool loop. The lane keeps the latest as
`reading`, with the engine and model that made it (`store.noteReading`),
and `laneFill` uses it only while the agent is on that engine and model,
with the table in `server/context.ts` as the fallback window, which the
lane then says is the table's. Without such a reading, or with neither
an engine's window nor a model the table knows, the lane has no fill at
all: the 32k default stays a margin for the fold, never a number shown.
The Usage tokens, the turn's own spend, are kept apart and counted as
before. The chips, the sidebar rows and Activity show that fill past
their own thresholds, and the composer of an agent's chat shows it as
one ring from the first answer on (`src/components/ComposerRing.tsx`),
only while the lane has a reading. Hover or a tap opens a card: the
tokens used of the window ("about" when the window is the table's), a
line when Bloks summarised the earlier part, and what the engine's plan
has left. Claude Code reports its plan's windows in `rate_limit_event`
(`unifiedWindows`) and Codex in `account/rateLimits/updated`; each engine
instance keeps only the latest, in memory (`server/plan-usage.ts`), and
`GET /api/plan-usage` serves it to this Mac alone, never to a phone, a
remote window or an agent, and it is never put in a prompt. A room has
no ring, since every agent in it has a context of its own. A turn that
answered with no tokens reported
(Pi does not report any) counts as unmeasured, and Activity says "not
reported" rather than showing zero.

A native session sends its whole context again on every tool call, so a
long one turns one tool-heavy message into millions of input tokens
(GitHub 222, 223). Before a turn resumes a session whose reading is over
the line (the lower of 60% of the window and a ceiling, 200k by default,
set in Settings as "Compact before a long turn" or off), the session is
compacted first (`compactBeforeTurn`). Claude Code is sent `/compact`
into the resumed session from `server/index.ts` with the turn's own tools
and system prompt, through the idle compaction's books (`compactThenSend`),
and the turn goes on once it ends; a person who stops the turn meanwhile
stops both. Codex is asked in the same process with
`thread/compact/start`, and an ACP agent with its own `/compact` when it
lists that command. When the engine cannot (an older app-server, an agent
without the command, a compaction that fails), the driver opens a new
session and sends the turn's `handoff` instead; an engine with no way to
compact at all gets a new session from the start. This applies to direct
and room lanes alike. A compaction that did not bring a lane under the
line is not asked for again until it has grown a tenth past where that
one started. A turn already running is never interrupted to compact; it
is checked again before the next one.

Whenever a new session starts on an existing conversation (an engine
switch, a backup taking over, a rewind, a cursor that no longer resumes,
or a replacement after a compaction it could not do), the story it is
told is bounded (`boundHandoff`): the running summary, then recent
messages whole while they fit, each clipped to a quarter of the budget,
which is 15% of the window and never more than 16k tokens. When that
leaves messages out and the agent's engine can summarise, the older part
is folded into the summary first; otherwise the message says how many
were left out. The thread itself keeps every message.

The same cache is why a resumed Claude Code session keeps its system
prompt byte for byte (`server/standing-prompt.ts`). The agent's
MEMORY.md and the notes about the person stay as they were when the
session started; a change since the agent last heard is said ahead of
the turn's message, after the cached history. In a room, the room's
recent conversation goes there too, only the lines this session has not
been shown. A fresh session gets everything current in its system
prompt, and other engines get the whole persona each turn as before.

## Turns cut off

A turn the Mac slept through, or one running when Bloks stopped, is
picked up rather than left dead, and both are picked up the same way
(`server/cut-off.ts`): a notice the person reads, and a separate note
telling the agent to carry on and to check what already happened before
repeating anything, naming the tool call that was running. Neither is a
message from the person, and the original request is not sent again.

Sleep is noticed while Bloks runs. A stop is not, so every turn is
written to `turns-in-flight.json` when it starts and taken out when it
ends, which makes a crash count as much as a quit. At startup each one
left is taken off the list and then picked up once, in the same lane,
room and engine session, for whoever asked for it; queued messages for
that lane go in the same turn. One somebody stopped, a workflow step, or
one whose agent was archived is dropped. One left longer than the queued
message window (twelve hours), or a pickup cut off in its turn, gets a
notice with Continue instead. Questions and approvals the old engine was
waiting on are marked cut off, and `/respond` delivers nothing for an ask
this run did not raise.

A settings change rebuilds only the engines it changes (a custom
endpoint, a key, a provider connected), and the rest keep running. A
turn on a rebuilt engine is ended where it stands, which frees the lane,
and picked up on the new engine the same way; one whose engine was
removed says so instead. An engine updated from the app is rebuilt too,
because engines read their models when they are built, but only once
nothing is running on it: right away when it is quiet, otherwise when
its last turn ends.

## Restarting for an update

Before a planned restart Bloks drains (`server/drain.ts`): nothing new
starts, what is running carries on, and the restart waits until nothing
is running or a deadline passes (twenty minutes unless asked otherwise,
an hour at most). The updater asks for it before it installs, and
`bloks-server drain` does the same for a server you restart yourself;
both go through `/api/maintenance/drain`, which answers only this
computer. A turn still running at the deadline is cut off and picked up
like any other, from the record it already has. While the updater
waits, the update card says how many turns it is waiting for and how
long is left, and offers to restart now (what is running is picked up
after) or to call the drain off and update later
(`electron/drain-wait.mjs`).

Nothing that arrives meanwhile is turned away. `startTurn` is where every
turn starts, so it is where a drain holds them: words for one of an
agent's lanes wait in that lane's queue, as they would behind a busy
turn, and that queue is the transcript, so it outlives the restart and
joins any pickup. Room lines wait the way they do for a busy agent, now
on disk too. What has no queue waits where it already would: a routine
stays due and fires late, inside its grace window; a workflow step waits
for its lane; a job stays open on the board; a watcher set to rehearse
keeps the change unseen and sees it again; an email waits in its line,
which is in memory, as it does for a busy Email lane. Questions, approvals and
workflow gates are left exactly as they are. A drain lives in memory,
so a restart ends it, and calling it off lets everything held go at once.
One whose restart never comes ends itself the same way, ten minutes past
its deadline.

## Queued messages

What the person says to a lane in the middle of a turn goes into that
turn when its engine can take it (`steerLane` in `server/index.ts`),
from the app, the phone or Telegram alike. Claude Code keeps the stdin
it was given the prompt on open and reads another stream-json message
after the step it is on; Codex takes it through `turn/steer`, naming the
turn it is running. A driver says it can with `steerTurn` in
`server/contracts.ts`. The message joins the conversation as the turn
takes it, after what the agent has said so far, and nothing is
interrupted; Stop is still how to do that. Claude's stdin is closed at
the first `result`, since that is what lets the process end; words
written just before it are answered by the same process in the same
turn, which ends on the last result. When the turn cannot take them (the
engine refused, its input is closed, the turn is a room's, someone
else's, or a quiet session being compacted, or Bloks is draining for a
restart), they wait as below. A Telegram follow-up goes into the turn
its chat is waiting on, and one answer covers both; a turn that did not
start from Telegram takes the words too, or they wait, and either way
the answer goes back to the chat instead of a refusal.

Another agent can ask for the same thing when what it says changes the
work under way: `bloks say <agent> --now <text>`, which is `now: true`
on `POST /api/bots/:id/messages` from an agent's credential. It is
honoured only when the sender's own message started the running turn
(`replyingTo`) or the sender may stop that agent anyway (`mayStop`),
both decided in `mayJoin`; joining is the gentler of the two, since
nothing is thrown away and the agent reads it after the step it is on.
Then it goes in through `steerLane` like the person's words, the engine
hears who it is from, the conversation keeps it as that agent's
message, and the sender is told the agent reads it after its current
step. Otherwise, or when the turn cannot take it, it waits as below and
the sender's answer says why. Without `--now` nothing changes, and a
room never takes it: its members speak one at a time.

Everything else said to a lane in the middle of a turn (another agent,
a webhook, a watcher, a routine, or the person on an engine that cannot
take words mid-turn) is written down at once, flagged `queued`, and
waits in memory (`steerQueues` in `server/index.ts`) until the lane
settles; everything waiting goes in one turn. None of it is part of the
conversation until then. The app shows it in a strip
above the composer, where your own can be reworded, sent now or taken
back, and when they go `deliverQueued` moves them to the end of the
transcript (`Store.moveToEnd`, ids unchanged) with a `message.patch`
frame marked `moved`. So the stored order is the order the agent heard
things in, and everything that reads it (a room's history, a replayed
transcript, an export) agrees. A room's own queue behind its current
round, and a pickup after a restart, deliver the same way.

## Agents writing to agents

`bloks say` to an idle agent starts a turn there, a paid one, and a
turn's own budget (`TURN_BUDGET` in `server/agent-cli.ts`) starts again
in every one of them, so it bounds a turn and not the back and forth.
That is counted on its own: each lane's latest turn has a place in a
chain (`agentChain` in `server/index.ts`), 0 when the person, a routine,
a watcher, a webhook or an email started it, and one more than the
sender's turn when an agent's message did, an agent writing to itself
included. A message that would start or wait for a turn past
`MAX_AGENT_CHAIN` (twelve) is refused: the sender is told to finish up,
and the conversation it was meant for says the next one waits for the
person. Whoever the person writes to next starts over at 0, whether
their words start the turn, join it, or are among what it takes when it
goes. A burst of waiting messages takes the furthest place among them,
and a pickup, a backup engine or a retry keeps the place of the turn it
continues. The places live in memory, with the queue they ride on,
rather than on the lane record: a restart begins every chain again,
which lets a loop that spans one run a stretch more at most, and leaves
nothing on disk to clear when a lane closes.

Rooms and the job board carry the count too, or an agent could keep
another going through them. An agent naming someone in a room, from the
room or from a conversation, hands the turn it wakes a place one past its
own; past the limit nobody is woken and the room says why. A room also
keeps the latest such place (`roomChain`) for a turn that waited, behind
a busy agent or a round, and anyone but an agent posting there clears it
as the post goes out. A job posted from an agent's turn
records the place its taker's turn would take; past the limit it is not
offered, and the person offering it again clears it. Routines and
watchers an agent files or changes do the same (`chain` on each): past
the limit a routine's run is recorded as held and a watcher holds
without looking, until the person changes it, runs it, or looks by
hand. Agents cannot file workflows. A round inside one
room is also bounded by `MAX_AGENT_HOPS`.

## Chat platforms

A shared room can be carried into Slack, Discord or a WhatsApp group
(`server/chat-bridge.ts` holds the rules, one transport file each moves
the bytes). Slack and Discord are connections this machine opens. WhatsApp
can only call a public address, so Bloks Cloud gives each workspace one
and hands every call over the relay line as an ask; the call arrives
readable, because Meta sends it that way, and is believed only if Meta's
signature checks out against the app secret, which stays here.

## Telegram

The person can reach their agents from a Telegram bot of their own
(`server/telegram.ts` holds the rules, the Telegram parts of
`server/index.ts` the plumbing). The machine long-polls Telegram, so
nothing listens on a port. Everything hangs on the pairing: the first
chat to send the single-use pairing word is the owner's, a chat that is
not paired is refused once and never reaches an agent, and nothing below
happens anywhere else. Guest mail and shared rooms never come this way.

A card a Telegram turn raises goes to the chat it came from
(`telegramCards`, `server/telegram-cards.ts`). An approval comes with
Allow and Deny to tap, a question with one button per choice; a question
with no choices, or more than eight, is answered by typing, and typing a
number or yes / no still works on any card. A button carries a short
random token and the choice's place, never the request id: Telegram
allows it 64 bytes, and a token that means nothing outside this process
cannot be replayed. Tokens live in memory for a day at most, so a button
from before a restart answers that its card has closed. A press counts
only from a paired chat, under the message the card became, from the
person it is paired with (`decide`); anyone else's is ignored without a
reply. The press is answered (`answerCallbackQuery`), the ask is
resolved like a typed answer, and the card's message is rewritten to say
how ("Allowed", "Denied", "Answered: ...") with its buttons gone. A card
answered anywhere else (the app, the phone typing, an engine giving up)
is rewritten the same way from `request.resolved`, and the chat's next
line is a message again rather than an answer to it.

What a Telegram turn leaves behind follows its answer to the chat
(`deliverablesIn`, `telegramFiles`): files it saved to its deliverables
folder (see `sweepArtifacts`) and the last look at its screen. Images go
as photos (`sendPhoto`) so they show in the chat, anything else as a file
(`sendDocument`), each a multipart upload read from disk only as it goes.
Five at most come with one answer, and Telegram takes 50 MB from a bot,
so the rest and anything bigger are named in one line saying they are in
the app. A request held through a restart gets its files after its answer
the same way (`TelegramReturns`), and only once that answer has arrived.
Files go only with an answer that goes to the chat: a turn started in
the app, a routine or a mail sends nothing there.

While a Telegram turn runs the chat shows "typing" (`keepTyping`), and a
turn still running after about twenty seconds also posts one line saying
what it is doing, "Working: <tool>..." (`telegram.Progress`, fed from
`item.started` through `telegramWorking`, keyed by lane). The same
message is edited as the tool changes, no more than once every four
seconds, and deleted when the turn ends, before the answer is sent: the
answer is a new message, so the phone still announces it. While a card
waits on the person neither "typing" nor the line changes, since the
agent is waiting then, not working.

## Teams as files

`server/team-file.ts` reads and writes a team as one Markdown file: a
heading per member, a few `key: value` lines, and the brief as the body.
Rooms export to it, imports go through it, and the gallery at
bloks.dev/teams is checked with the same parser before anything reaches
the hire dialog.

## The morning brief

`server/brief.ts` composes a brief from what is already stored: each
agent's lanes since the last brief (the last reply's first sentences and
how many files its change cards touched), the live questions and
approvals (`waitingOnYou`), the day's usage buckets, and counts of things
ready for a look. No model call. A minute timer makes one when the chosen
time has passed and today's has not been made (`briefDue`), and a
`brief.ready` frame wakes the owner's phone with a sealed preview.
`/api/briefs/:id/parts/:n/audio` speaks one part in that agent's voice,
or a Mac voice picked per agent. Quiet check-ins (see Routines) are left
out of what an agent worked on and said as one count at the end of its
part ("12 quiet check-ins, nothing needed you"); they are not things in
the headline, and a night of nothing but them is still a quiet night,
which wakes no phone.

## Routines and check-ins

`server/routines.ts` keeps routines in `routines.json` and a thirty
second timer (`runDueRoutines` in `server/index.ts`) fires whatever is
due. A routine runs at a time of day on chosen days, once on a date, or,
for an agent, as a check-in: `every` so many minutes (15 to 1440),
within `activeHours` (`from` and `to`, local, on one day, both ends
included) on chosen days. A check-in's slots start where its hours do
and step by its interval, so they fall at the same times every day
(`checkInsOn`); its `time` is its first slot, for clients that read only
that. A missed slot fires once, within the grace window (two hours, or
half the interval for a check-in, since by then the next one is nearly
due), and never for a slot from before its schedule was set
(`scheduledAt`, moved by a change of time, days, date, interval or
hours). An interval or hours that cannot run, a check-in that is also
once, and a check-in or quiet routine for a room are refused with the
reason (`scheduleProblem`); a room's routine keeps to a time of day,
since several agents answer it and a channel may be reading. The agent
command line files one with `bloks routine --every 30m --between
09:00-18:00`, and `--quiet` for a time of day.

A check-in is always quiet, and a time-of-day routine can be (`quiet`).
Its prompt is marked `routine.quiet`, and the turn is told, in its own
words after the line saying where it came from and never in the system
prompt, which a resumed session keeps byte for byte, that if nothing
needs the person it answers with exactly QUIET (`QUIET_ASK`). While it
runs the lane is in `checkInTurns`: its start leaves the lane's unread
as it was, its message frames carry `checkIn` so the app holds their
banner (`CheckInHold` in `src/lib/notify.ts`), and an answer of QUIET
(trimmed, any case, with a full stop or exclamation) is written with
`quiet: true` at once. When the turn ends well with QUIET as its last
words, nothing but words, tool calls, a screen or a compaction marker
after the prompt, and none of the person's words joined it,
`foldQuietRun` marks the prompt and everything after it `quiet`: no
unread, nothing for a banner, a linked chat or the phone, the run is recorded
`quiet` in its history (an "ok" run with the flag) and left out of the
record, whose recent view a check-in every quarter of an hour would
flood. A check-in that fails, reports anything else, raises a card or
saves a file is shown like any turn, and its held reply is announced when
it ends. The chat folds a run of quiet messages into one muted line ("3
quiet check-ins, last at 10:30", `quietRunAt`), which opens to show
them; the sidebar's line and a lane's `lastAt` read past them.

Each routine keeps what its last run that was not quiet said
(`lastReport`, apart from the twenty `runs`, which quiet runs would
otherwise push it out of), and its next turn carries it as a note before
the prompt ("Last time this routine reported: ...", one line, about 600
characters at most), so a run that lands in a fresh or summarised
session still knows what it said. The note is said only as the turn
goes; a replayed transcript has the answer in it already.

The routine editor (`src/components/RoutinesDialog.tsx`) chooses At a
time or Every, in minutes or hours, with hours and days, and the quiet
switch for a time of day (`src/lib/checkIns.ts` holds its checks). The
calendar in Automations draws a check-in as one thin band over its hours
with a tick per run, rather than a card per run that would bury the
week, as one chip a day in the month, and as a row in words in a
Check-ins strip under the grid; its history folds a stretch of quiet
runs into one row.

## Watchers

`server/watchers.ts` looks at a folder (a snapshot of names, sizes and
times, compared), a page (its readable text, hashed, with the new lines
as the change, optionally only when it mentions something) or a feed
(RSS or Atom entries not seen before). Folders are watched with
`fs.watch` and settle for twenty seconds; everything is also looked at on
its `every`. A first look is a baseline. A change becomes a turn in the
agent's first conversation or the one the watcher names (see Lanes), or a
rehearsal (`openRehearsals`), with the message marked `via: "watcher"`.
A look is skipped while the agent is busy, so its own edits are not news
to it, and `mayFire` caps a watcher at six turns an hour.

## Meeting notes

`electron/resources/speech-helper.swift --meeting [--system]` transcribes
the microphone and, through ScreenCaptureKit (weakly linked, macOS 13+),
the Mac's own sound, closing a recognition request at each pause so every
stretch of speech is a segment. The renderer posts segments to
`/api/meetings/:id/segments`; ending the meeting gives the chosen agent a
turn in its Meetings lane with `notesPrompt`, and `actionItems` reads
"- Owner: task" lines back out of the reply for one-press handoff.

## Recall and notes about the person

`server/recall.ts` searches an agent's own lanes and the rooms it is in
(only the room itself, from a lane of a shared room), words in any
order, with the message before each hit. Agents reach it with the CLI's
`recall` and chat engines with the `search_history` tool.
`server/profile-notes.ts` holds suggested and kept notes about the
person; agents suggest with `note` or `note_about_person` (three a turn),
only kept notes reach the prompt, and never in a shared room.

## Engine scout

`server/engine-report.ts` logs every finished turn with the engine and
model that ran it, and reads its outcome later from existing records:
undone (the checkpoint was reverted), rewound, discarded (a rehearsal),
failed, or out (the engine ran out). A lighter model in the same family
with at least eight judged turns and a kept rate within five points is
suggested for that agent.

## Email your agent

Mail to `<agent>.<id>@agents.bloks.dev` is received by Bloks Cloud and
arrives as a `hook:` ask with `platform: "email"`, like WhatsApp.
`onEmailHook` routes it by the name before the dot, checks `allowFrom`,
dedupes by Message-ID, and queues it into the agent's Email lane (or
"Unlisted email", below); the reply is the agent's last message, sent
back through Bloks Cloud, which only sends to an address that wrote in.

With `allowFrom` empty anyone may write, so a mail's turn runs on none
of the owner's standing trust: its requester is `MAIL_FROM_ANYONE`, and
it is answered the way a guest in a shared room is (`guestMail` in
`startClaimedTurn`). Only an engine whose tools can be switched off
(`sharedSafe`) answers it; on Codex, an ACP engine or the computer the
lane says why and nobody is emailed, since a shell that asks before
acting still reads the whole disk without asking, the owner's keys
included. The driver gets `shared: { tools: "conversation" }` and
`untrusted`: no tools, none of the owner's connectors, MCP servers,
computer, browser or extra folders, no CLAUDE.md or auto memory, no saved
secret and no agent credential. The persona leaves out the owner's
profile, notes, memory, attached skills, project brief, folders and the
team protocol, and no team plan is read from its answer. Each mail
starts a session of its own with no transcript and nothing compacted
first, and its session is dropped when it ends, unfolded and unread for
skills, so one stranger never reads another's mail and no turn of the
owner's resumes one. The reply is what was said after the mail, and any
other turn starting in the lane ends the wait for it, so nobody is
emailed words that were not their answer. A pickup after a cut off takes
none of the words queued in the lane, and a context error is not folded
and retried. `search_history`, `read_message`, `note_about_person`,
`request_secret` and `request_connection` are refused: a secret saved or
an app connected from such a card would resume the turn as the owner's.
A question it asks the owner says whose mail it is for and is never
sent to the owner's phone. It is answered in a lane of its own, made as "Unlisted email" and
marked (`TaskRecord.guestMail`) rather than known by its title, so it
keeps all of this when the person renames it; nothing names it, and a
lane 2.5.36 made under that title is marked on the next start. Never in
"Email", and at the lane cap it waits rather than borrow another lane;
no other work falls back into that lane either, and work that names no
lane (a phone message, a room's turn) goes to the first conversation
when that lane is the one open (`activeLaneOf`). A backup engine or a
retry after a fold goes on for the same requester, read when the error
arrives, and a pickup after a restart reads it from the turn's record.
During a drain it waits in the mail line rather than as a note in a
lane, since a note runs as the owner's. Mail from an address or @domain
in `allowFrom`, checked when its turn starts, runs as the owner's own,
in "Email".
Webhooks are not affected: their address is a secret the owner handed
out.

## MCP server

`bin/bloks-mcp.mjs` is a dependency-free stdio MCP server that finds the
local Bloks on its known ports and offers eight tools (list agents and
rooms, ask an agent and wait for the reply, post in a room, read a
conversation, search, the latest brief, what is waiting). It has no tool
that approves, deletes or configures. `/api/mcp-config` gives the command
to paste, using the runtime the server itself runs on.

## Lanes, unread and the sidebar

An agent keeps up to twenty lanes (`MAX_TASKS` in `server/store.ts`), each
its own transcript, engine cursors and busy flag. Closing the last lane
opens a fresh General in its place, because the active lane is what
`threadId` names everywhere and an agent without one would be a special
case in every route.

One conversation per agent is the default. A routine, a watcher or an
agent's webhook speaks in the agent's first lane, General, where the
person talks to it, unless it names another with `thread` (the routine
editor's Conversation, `--thread`, the webhook's Conversation), so two
routines can still run side by side with their own context. `namedLane`
reads a name as a lane's id first and its title second; a title nobody
has is made when the work first needs it, and an id never is: one that
is not this agent's lane is refused when filed and, once its lane has
closed, sends the work to the first lane. A turn there shares the lane
with the person, so what they say meanwhile queues behind it or joins it
as steering. Everything filed before this kept going where it went: on
the first start after the update, each one that named no lane was given
the one it used ("Routines", "Webhooks", a watcher's "Watching: <name>"
by its title then), once, marked by `oneConversationAt` in
`config.json`. A watcher's own lane is one it made under that name, and
closes with it.

The chat's tab strip shows only while an agent has more than one lane;
New conversation is on the agent's row in the sidebar (its menu, and the
`+` of the conversations view), as Clear is.

Unread is per lane: a turn that ends in a lane marks that lane
(`store.markLane`), except a quiet check-in (see Routines and check-ins),
which leaves it as it was, and the agent's own `unread` is kept as "any lane
unread" so the iPhone app and the Dock badge read it unchanged. Opening a
lane (`POST .../tasks/:id/activate`) reads it; `PATCH /api/bots/:id` with
`unread` reads or marks the lane on screen. The client's `select` goes to
the lane that pinged (`pingedLane` in `src/state/reducer.ts`) unless it is
given one, so a dot on an agent always leads somewhere. `clientBot` ships
each lane's `unread` and `lastAt` for the sidebar.

Inside each list of the sidebar (a section, or the unfiled Rooms and
Agents at the top) the order is one rule, `compareRows` in
`src/lib/sections.ts`: pinned rows first by `pinOrder`, then the rest by
`activeWithYouAt`, most recent first, with `createdAt` and the id settling
ties. All of those fields live on the agent and room records, so every
device draws the same list; `sidebarLayout` gives the whole sidebar in
that order for anything that walks it. `activeWithYouAt` moves when the
person writes, when a turn they started replies, and when anything asks
them something (`towardYou` in `server/activity.ts`), never for one
agent messaging another or a routine waking one. Pins and places are set
through `PATCH /api/bots/:id` and `PATCH /api/bloks/:id` with `section`,
`pinned` and `position`, which renumber the section's pins; the order of
the headings is `GET /api/sidebar` and `PUT /api/sidebar/sections`, kept
in `sidebar.json` and announced as a `sidebar` frame.

The sidebar's conversations view (`src/components/SidebarParts.tsx`) is a
per-device choice in `localStorage`. Settings is a page beside the
sidebar, like Automations, with its pages listed once in
`SETTINGS_PAGES` (`src/components/AppSettingsPanel.tsx`); anything that
links into Settings passes a `page`, and the command palette searches the
same list. Escape is handled once (`src/lib/useEscape.ts`): the most
recently opened surface that asked for it closes, and Radix menus and
dialogs keep their own.

## Approval modes

An agent's `approvals` is `ask`, `edits`, `auto` or `full`, and new agents
start on `cfg.agentDefaults.approvals` (`GET`/`PUT /api/approvals`, which
can also move every agent; never reachable with an agent's credential).
The first three are Bloks' own gate: deny rules first, then the mode
decides whether a request becomes a card. `full` also sets `fullAccess`
on the turn, and each driver takes its engine's own guard off: Claude
Code runs with `bypassPermissions` and no approval bridge, Codex with
`danger-full-access` and `approvalPolicy: never` (stated on resume too),
ACP engines in their `yolo` mode, Antigravity with
`--dangerously-skip-permissions`. Nothing asks, so rules cannot refuse
anything in that mode. A shared room never gets `fullAccess`, and nor
does an email from anyone (see Email your agent): a turn somebody other
than the owner asked for is held to the owner's yes, whatever the mode.

## Boundaries worth knowing

- `server/http-guard.ts` checks `Origin` and `Host` on every request.
  Loopback is not a boundary in a browser.
- `server/limits.ts` holds every input cap in one place.
- `redactSecrets` scrubs stored keys and key-shaped strings from anything
  returned to the client.
- Approval requests block the turn. The driver holds the provider's
  request open until `respondToRequest` resolves it.

## Engine setup

`server/engine-setup.ts` installs an engine CLI when the person presses
Install, and opens Terminal at its sign-in when they press Sign in. Installs
run through the person's login shell, so they see the same node and PATH
their Terminal does, and write only under `~/.local`: the native installer
for Claude Code, `npm install -g --prefix "$HOME/.local"` for the npm ones.
A failure comes back as the next step (install Node, check the network)
with the installer's own output behind a disclosure. The routes answer
only a window on this computer and never an agent. Claude Code and Codex
report signed in or not (`claude auth status`, `codex login status`), and
the first-run check counts an engine as ready only when it is both.
