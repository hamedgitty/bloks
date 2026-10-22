# Architecture

Three pieces, one rule.

| Layer | Location | Responsibility |
| --- | --- | --- |
| React app | `src/` | Chat, rooms, agent roster, panels, avatars |
| Harness server | `server/` | HTTP API, one SSE stream, provider registry, persistence, approvals |
| Electron shell | `electron/` | Desktop window, one server per workspace, speech and computer bridges |

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
   transcript), ends the briefing with the reply rules (`replyRules` in
   `server/house-style.ts`, last on purpose, since agents read past the
   same asks higher up), photographs the agent's folder
   (`server/checkpoints.ts`), then calls the driver's `sendTurn`.
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

A lane reads as working from step 2, but its engine is only started at
the end of step 3, which can be a moment or, with a box to wake or a
large folder to photograph, a minute. A stop in between has no engine
turn to interrupt, so it is kept (`stoppedGettingReady`,
`interruptLane`) and honoured at the last check before `sendTurn`, the
same check that turns away a turn for an agent archived or held in that
time: the turn ends there with a notice, and its engine never hears it.

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
lead speaks last. The lead is the member the person crowned for that room
(`leadId`), or the most senior when nobody was (`leadOf` in
`server/bloks.ts`). Handoffs raised mid-round queue rather than
interrupting, then drain in further rounds, bounded by `MAX_AGENT_HOPS`.

**Sessions belong to agents, not rooms.** An agent's provider session is
keyed to its own thread id. `activeRoom` redirects that agent's events
into whichever room it is currently speaking in. That is why an agent
remembers a room conversation when you DM it afterwards.

Agents pass a room along between themselves three times at most before
the person has a say (`MAX_AGENT_HOPS` in `server/room-hops.ts`). The
count travels with the turn, not with the agent (`turnHops` in
`server/index.ts`, by lane, set as the turn starts): none for a turn
anything but a room mention started, the person's post in the room
included, one more than the turn that named it for a mention's, and
unchanged for a pickup, a backup engine or a retry. So a room chain that
has ended does not hold what the same agent says from an unrelated turn
afterwards, in the room or into it with `bloks say`. A mention that
waits for a busy agent (`server/room-tags.ts`) is delivered at the count
it was made at. A mention from a turn already at the bound wakes nobody,
and neither does one still waiting when a round's further rounds run
out. Either way the room gets one notice saying who named whom and that
posting there carries on, where the mention used to be stored and
dropped without a word.

Team formation (`server/teams.ts`) sits on top: a senior agent can emit a
fenced plan, which becomes an approval card. Only your yes creates the
agents and the room.

## Persistence

Plain JSON in the workspace's data folder (`~/.bloks` for Personal, see
Workspaces), written synchronously. No database.

| Path | Contents |
| --- | --- |
| `bots.json` | Agent records, model selection, resume cursors |
| `bloks.json` | Rooms and members |
| `sidebar.json` | The order of the sidebar's section headings |
| `turns-in-flight.json` | Every turn while it runs, so one cut off by a stop is picked up |
| `room-lines.json` | Room lines waiting for a busy agent, or for Bloks to be back |
| `engine-pauses.json` | Engines and models paused for a while, only while any are (see Engine pauses) |
| `incidents.json` | What failed, who has it and how it ended, and the quiet desk's one card (see The incident desk) |
| `workspace.json` | The workspace's name, kind and mark, as the app last said them, for invites |
| `people.json`, `joining.json` | Members, guests and devices; invites, the join key and password, and the joining switches (see People in a workspace) |
| `member-limits.json`, `owner-plan.json` | What each member may spend and has spent this month; the owner's plan as last known |
| `reads.json` | How far each person has read each conversation (see Read positions) |
| `usage.json`, `model-prices.json` | Daily usage by agent, engine and person; the public price list estimates come from (see Usage and spending limits) |
| `plan-cache.json` | The Plan page's last good answers from bloks.dev, under a fingerprint of the key |
| `location.json` | The owner's iPhone's last reading and whether each phone shares, never a trail; left out of backups and moves (see Location) |
| `messages-<id>.json` | One transcript per agent or room, same key space |
| `config.json` | Connected providers and keys, `0600` |
| `skills/*.md` | Installed skills |
| `setup-import.json` | What was brought over from other agent tools, by item: a digest, where it went, and the exact text added |
| `session-import.json` | Which past Claude Code and Codex sessions became which lanes, with the digest of what came over |
| `engine-sessions.json` | Engine session ids Bloks itself ran, so they are never offered back as past sessions |
| `events/`, `native/` | Canonical events, and raw provider traffic |
| `checkpoints/` | Content-addressed file versions, one photograph per folder, and the undo records |

Backups of all of it go beside it, never in it: `~/.bloks-backups`, one
file each (see Backups and restore).

A store writes its whole file on every change, with one exception: a
turn's tool call rows and their results wait up to a quarter second
(`ROW_WAIT_MS` in `server/store.ts`) and go out with whatever else
changed, one write per transcript, because rewriting a long conversation
twice for every call took most of the server's time. Any other write of
that transcript takes them along at once, and the turn's end and a
process on its way out write what is waiting. Where losing that file
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
edits made from the Memory place. Undo follows the checkpoint rule: only
a file still exactly as that change left it goes back, and a file that
has become a link is never written through. A change recorded through
Bloks while a turn of that agent runs (the agent's own `bloks memory`
write, an API engine's `memory_write`, the person's edit) also updates
the turn's photograph, so the turn's end does not find it again: one
edit, one entry, by whoever made it. An agent's write through the CLI
or a tool is the agent's; an agent file's import, a copy from another
agent and the editor are the person's.

Shared memory is one `DATA_DIR/shared/MEMORY.md` the person keeps for
every agent, under the same 200 line and 24,000 byte budget, journaled
under the owner id `_shared` with the same undo (`/api/memory/shared`,
its `journal` and `journal/:id/undo`). It is the standing prompt's third
moving part (`server/standing-prompt.ts`), so a resumed Claude Code
session keeps its cached copy and hears a change in its message, and it
has the notes' gate: never in a shared room, a stranger's mail or a
Telegram person's turn. Agents read it (`bloks memory --shared`, and the
prompt) and never write it; the write route refuses an agent's
credential and the agent guard does not list it.

Memory is a place on the main rail (`src/components/MemoryPlace.tsx`):
a sidebar of its own lists Shared, About you and every agent, and the
page beside it is the one picked. The sidebar is a page column
(`src/components/SideColumn.tsx`), as Settings', Plugins', an agent's
settings' and Automations' lists are: sized by its edge and folded with
Cmd+B. Folded, Settings' pages are tabs along the top, and Memory's and
Plugins' are a small switch at the top left of the page. Links open it
with `openMemory` and a target (an agent's id, `you` or `shared`), which
Back and forward remember. About you edits the same `profile.about`
Settings does. The place reads `GET /api/bots/:id/memory/stats` for its
meter (lines and bytes against the budget, topics with sizes and times),
searches with `GET /api/memory/search` (every listed agent's memory and
the shared memory, from recall's own indexes), and copies with
`POST /api/bots/:id/memory/copy` (picked topics, appended to one the
agent already has, and picked MEMORY.md lines it does not have yet, each
file one undoable entry). It follows `memory.changed` on the stream
rather than polling; `botId` is `_shared` for the shared memory.

API engines with tools keep memory with `memory_read` and `memory_write`
(`server/drivers/openai-compat.ts`), answered by the workspace like
`note_about_person`: refused for a stranger's mail and a Telegram
person, a write refused in any shared room, and a read there only where
the owner let the agent's memory in. An empty text for a topic forgets
it. CLI engines have `bloks memory --topics`, `--topic <name>` with
`--write` or `--forget`, on their own topics only.

Room ids and agent thread ids share one key space, which is why a room
transcript and a solo transcript are the same kind of file.

## Workspaces

A workspace is a data folder and the one server that runs on it. Every
path in this document that says `~/.bloks` means the workspace's own
folder, `DATA_DIR` in `server/config.ts`: `BLOKS_DATA_DIR` when it names
one, else `~/.bloks`. The server, the command line tools in `bin/` and
the safety floor all read it from that one place, and
`server/data-lock.ts` keeps it to one server per folder.

The desktop app keeps the list (`electron/workspaces.mjs`, pure and
tested in `test/workspaces.test.ts`) in `workspaces.json` in its own user
data folder: each workspace's id, kind (`personal`, `business`, `custom`
or `joined`, and `hosted` for the managed hosting that is coming), name,
whether it is a team's, mark or logo, data folder, mute, notification
level, order, last port and accent, and the person's own preferences
(theme, the accent shared by every workspace when that is on, and the
name they go by). The order is the person's: holding a workspace in the
switcher and dragging it, or Option and the arrow keys, rewrites it
(`reorder`), and every list of workspaces follows it. The first launch
with workspaces finds no list and writes one with the folder Bloks always
had as Personal, exactly where it is: nothing is moved or rewritten to
get there. Other workspaces get `<user data>/workspaces/<id>`, so a
rename never moves a folder. Personal cannot be deleted. Marks are a 3x3
pattern and a colour (`electron/workspace-marks.mjs`): Personal and
Business start on their own, and a named workspace draws one that is
neither of those and that no other workspace on the computer wears. Any
of them can wear one the person picks from the picker's colours and
shapes, at the Mac or from the owner's phone (`server/workspace-mark.ts`,
which puts the phone's choice to the app), and the app keeps it only when
no other workspace here wears it. On a joined workspace, the mark picked
is the member's alone (`ownMark`), kept in their list and never sent to
the owner, whose own mark stays beside it. A new workspace opens on a
short welcome shaped by what was chosen for it
(`src/lib/workspaceWelcome.ts`): a name and logo for a business, the
agents for its work, inviting people for a team, and nothing about
members for one person.

`electron/main.mjs` starts one server per local workspace, a few at a
time behind the window, each a `utilityProcess` with `BLOKS_DATA_DIR`,
`BLOKS_PORT`, `BLOKS_WORKSPACE_ID`, `BLOKS_WORKSPACES_DIR` and the
workspace's name, kind and mark in its environment. Personal keeps the
port order it always had (`BLOKS_PORT`, its `config.json`, the last port,
then 8799, 18799 and 28799), because a phone paired on the network
remembers it; the others take the port they had last, their
`config.json`'s, or any free one. The window shows one workspace and
switching points it at another server; the rest keep running, so a
routine or a watcher in a workspace nobody is looking at still runs on
time. A server that will not start is marked in the switcher with a way
to try again, and the app opens on the next one that does. The safety
floor keeps agents out of every folder under `BLOKS_WORKSPACES_DIR`, not
only their own workspace's.

A development run (`pnpm dev:desktop`) shows the dev server and starts
none of its own. `BLOKS_DEV_WORKSPACES=1`, after `pnpm build`, makes it
host the workspaces the way the installed app does.

Each server talks to the app over the port Electron gives only its own
children (`process.parentPort`), never the network:

- **Banners.** What a window would have raised a banner for, decided by
  the window's own rules (`server/desktop-notice.ts`, held to
  `src/lib/notify.ts` by `test/desktop-notice.test.ts`) and marked
  `needs-me` or `activity`, plus how many conversations are waiting. The
  app holds each to that workspace's mute (15 minutes to 24 hours, or
  until turned back on) and level (all, only what needs the person, or
  nothing), and the Dock badge and the switcher's dots are the sum.
- **The licence.** The app keeps one Bloks Cloud licence in the keychain
  for every workspace and hands it to each server as it starts
  (`{ kind: "licence", key }`); a server that already held one offers it
  back once, and `licence.forget` takes it away everywhere. Relay
  activation names the workspace id, so one licence holds a space per
  workspace: `GET /api/relay/plan` says how many are online in the
  relay's words, and `DELETE /api/relay/space` frees this workspace's
  place while keeping the licence, so `POST /api/relay/activate` with
  `again: true` needs nothing typed. A workspace's own licence still wins.
- **The plan and the name.** One plan holds for every workspace. A
  server says the plan it knows (`desktop.plan`), and the app takes that
  word only when it is about the app's own licence, keeps it under the
  licence's fingerprint (`electron/account-plan.mjs`, `account-plan.json`
  in its user data folder) and hands it to every server with the licence
  (`{ kind: "licence", key, plan }`, then `{ kind: "plan" }`), so a
  workspace made today is on the plan from its first frame and a new
  workspace's Team choice can say what it needs. The owner's name
  (`desktop.name`) the app keeps once and hands to every workspace
  (`{ kind: "name" }`).
- **Stopping.** `{ kind: "stop" }` ends a server cleanly on every
  platform, engines and folder lock included.

A workspace joined on somebody else's computer has no folder here. It
opens through the remote proxy (`electron/remote.mjs`) with the member's
credentials, kept in the keychain like `remote.bin`, and the window
draws a member's app from the member routes (see People in a
workspace). One joined without Bloks Cloud is reached on the owner's own
network only, through `startLanProxy`, a loopback stand-in like the
relay proxy.

## Clients that are not on this machine

The phone, a browser at bloks.dev/web, and the desktop app in remote mode
all reach a workspace the same way. Each is a paired device with its own
token; the workspace keeps only its sha256. Both ends derive one AES-GCM
key per direction from it (`server/relay-crypto.ts`), every request and
every event frame is sealed for one device, and the relay in between
carries ciphertext it cannot open. A browser keeps the two keys as
non-extractable WebCrypto keys and never the token. Routes that mint new
pairings answer only on this machine, but for the one that lets the
owner's paired phone pair another workspace of theirs (below). A member's
device, or a desktop app that joined the workspace, reaches it the same
way with a member credential and is held to its own surface (see People
in a workspace); one that joined on the owner's network alone calls it
over plain HTTP on that network with its device token as the bearer.

Pairing on the same network (`server/pairing.ts`) is off until phone
access is switched on (`PUT /api/pair`), and the bind follows the switch
only at the next start. Settings, Phone and devices is a short onboarding
until a phone is paired, then the list (`src/components/DevicesSection.tsx`).
No code exists until somebody asks: `POST /api/pair/start` mints a six
digit code and a QR token, in memory only, one at a time, for five
minutes; the window asks for the next just before one runs out while the
panel is open and visible, and `POST /api/pair/cancel` closes it the
moment the panel closes. `POST /api/pair/claim` takes either credential
and counts every try, and five checked tries close the code.

A phone whose saved address went stale finds the Mac again on its own.
While phone access is on and the server listens on the network, a server
the desktop app started on a Mac announces itself as `_bloks._tcp`
through `dns-sd` (`server/announce.ts`), named for the computer alone (a
workspace's name can be a client's, and the whole network hears it), with
`ws=` in its TXT record: `workspaceTag()`, a
hash of a random `announce-key` in the workspace's folder, which
`/api/health` also says as `tag`. A small shell watches the server and
ends the announcement with it, however it went. The phone trusts nothing
it hears: before its token goes to a new address it sends a hint (the
first 16 hex of a sha256 of its token's digest) and a nonce to
`POST /api/pair/prove`, and only a Bloks holding its pairing can answer
with the HMAC of that nonce keyed by the digest.

A phone the owner paired with one workspace can learn the others on the
computer and pair one in a tap (`server/other-workspaces.ts`):
`GET /api/workspaces/others` and `POST /api/workspaces/others/:id/pair`,
for the owner's own paired devices only. The question goes to the app
over the parent port, since only the list knows the workspaces; it names
only the person's own (`OWN_LOCAL_KINDS` in `electron/server-line.mjs`),
starts the one asked for if it has to, and asks its server for a single
use pairing of three minutes, through Bloks Cloud when it is online, else
on the network when phone access listens there (`mintPairing`). A device
gets five in ten minutes (`MintLimiter`), and the app shows a notification
for every one made, whatever the workspace's notification settings.

A person can watch an agent's browser or cloud computer from the phone and
work it. Live frames go out on the stream only on this machine and the
same network; a phone through Bloks Cloud asks `GET /api/bots/:id/screen`
for the newest one, and `?watch=1` keeps the browser or box pictured for a
minute after its last look (`watchScreen`), turn or no turn, without
opening a browser or waking a box to do it. `POST /api/bots/:id/browser/:act`
and `POST /api/bots/:id/computer/:act` take a click, a scroll, a key or
typing (`handsFrom`), never from an agent's credential. While an agent's
turn drives the Mac itself (`drivingMac`), the same screen route answers
the person with a picture of the Mac's screen: the server asks the app
(`desktop.screen`), which takes one only if Screen Recording is already
granted and never asks macOS for it (`answerScreen` in
`electron/main.mjs`), at most about once a second however many ask. It is
never broadcast, never answered to an agent's credential, and there is no
route that clicks on the Mac.

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

A phone's Live Activities follow the turns the owner is waiting on
(`server/live-activities.ts`): only a turn the owner's own message started
or joined, from any device, never one another agent, a routine, a watcher,
a webhook or a member started. The phone hands over its activity tokens
with `POST /api/live-activities` (feature `live-activities`), and a
push-to-start token on iOS 17.2 or later. A turn that is still running a
few seconds after it began gets an activity on each owner phone that does
not have one for that agent already, at most two per phone with the
newest replacing the oldest; an unanswered card turns it to waiting; and
once its lane has stayed free for a few seconds (so a retry or the backup
engine taking over is the same wait), every phone's activity for it is
ended. These go through the relay as ActivityKit pushes, which Apple
reads, so they carry only a state word, the turn's start time and opaque
ids, with the agent's name and the conversation sealed for the device.
The tokens are kept per paired device, swept against the pairing every
minute (which also ends what a restart left behind), and dropped when the
device is unpaired. Without Bloks Cloud there is no way to push, and the
phone keeps only the activities it starts and ends itself.

Both list routes accept `?messages=N` to keep only the newest N messages
of each conversation, including zero for names and rosters alone. The CLI
and MCP room discovery use zero; their history reads use the separate room
messages route. Missing or invalid counts keep the full local transcript,
so app hydration still has its history. Through Cloud, `olderMessages`
counts everything omitted, including when the requested tail is zero.

The desktop also windows the rendered rows. `useHistoryPaging` reveals the
next local window or asks `useEarlier` for one server page when an opening
or resized transcript leaves unused height. It stops when filled, exhausted,
on a nonadvancing page or error, or after eight automatic expansions. Folded
pages can advance without growing the column. The manual button remains at
that ceiling, and intentional upward paging shares the same exclusion latch.
Each visit owns its requests and measurement frames. Prepending holds an
identified visible row measured after the wait, so new tail content does not
move a reader who scrolled away. Find targets and the room's topics lens
suppress paging that could displace their position.

## People in a workspace

A workspace has one owner, the person whose computer it is, who holds no
Person record and no role. Everyone else is either a member of the
workspace, with the role `member` or `admin`, or a guest of some of its
rooms (`server/people.ts`, `people.json`, version 3). A member came in
through a workspace invite, or was made an admin by the owner, and
reaches the workspace's team agents and the rooms open to them. A guest
came in through one room's own invite (the older share flow) or only
ever talks from a linked chat channel, has no role, reaches that room
and nothing else, never hears the members list, and counts against the
room's places rather than the workspace's. Room memberships still exist
underneath, because a room keeps its own roles (collaborator, viewer)
and its own joining date for what history a person sees.

### Who may see what

Every rule is in `server/access.ts`, as plain functions over plain data,
and the server asks it before anything leaves:

- Every agent that is not solo is a team agent with one shared team
  conversation. Its access list is everyone (the default), only some
  people, or everyone except some (`PATCH /api/workspace/agents/:id/access`,
  with whether admins are always in). The owner always is.
- A room is everyone or chosen people (`PATCH /api/workspace/rooms/:id/access`).
  Anybody in a room meets every agent in it there, whatever the agent's
  own list says. `GET /api/workspace/access` lists both, with each room's
  own guests apart.
- Anybody who can reach a team agent, in its team conversation or a
  room, also has a private conversation with it. Nobody else reads it,
  the owner included, unless the owner turns on "Owner and admins can
  read members' private conversations" (`PATCH /api/workspace/joining`
  with `privateReadable`), and every member is told which way it is set
  (`privacy.line`). While it is on, `GET /api/workspace/private/:botId`
  lists them for the owner, to read only.
- A solo agent is its maker's alone: not listed for anyone else, its
  conversations theirs, and only they can put it in a room.
- Approvals in a team conversation or a room are answered by the person
  whose message started the work, the owner or an admin; in a private
  conversation or a solo agent, by its person.
- In a team conversation or a room, the owner or an admin may tell an
  agent to message somebody who can reach it. The agent posts into that
  person's private conversation, marked as sent on their behalf:
  `message_person` on Claude Code's bridge and on API engines, `bloks
  message-person` for the engines with a shell. A turn an admin started
  gets a credential that can do that one thing. Members never message
  each other through an agent.

A member's device reaches `server/member-access.ts` and nothing else.
Every route a member may call is named there, and anything unnamed is
refused, so a route added anywhere else in the server is closed to
members until somebody decides here that it should not be. The member
routes (`/api/member/...`) give the workspace as a member sees it, the
agents they reach and their own solo agents (made within their cap, on
the engines they are allowed, and deleted by them alone), each agent's
`team` and `private` messages and cards, their usage, their own notes
about themselves (kept apart in `people/<id>/profile-notes.json`), their
read positions, and leaving (`POST /api/member/leave`, which revokes
every device, closes their streams, archives their solo agents and drops
their private conversations, and tells the owner with a
`workspace.left` frame). The event stream reaches a member only through
`memberFrame()`, which strips what is the owner's (tool arguments,
screenshots of the owner's screen, file paths, the buttons on
approvals); a reply's words stream to whoever may read its
conversation. An admin's device also reaches the people routes:
invites, requests to join, roles, limits and access. The join password
and the approval switch stay the owner's.

### Invites and joining

One invite is one person (`server/invites.ts`): a code, a QR and a link
that are all the same invite, single use, for a day, cancellable, and at
most twenty waiting (`POST /api/workspace/invites` with an optional name
and a role; `PATCH` and `DELETE /api/workspace/invites/:id`). The code is
8 characters from an alphabet with no 0, O, 1, I or L, shown as
`K7QF-M2XR` and read in any case, with or without spaces and dashes. The
link is `https://bloks.dev/j/<publicId>#<code>`: the public id only names
the preview card, and the code sits after the `#`, which no server sees.
Kept in `joining.json`, readable by the owner alone: the code's sha256
(what the relay indexes) and the code itself, so the owner can read it
out again, with the role, name, expiry and tries. Bloks Cloud learns the
hash, the public id and the preview (workspace name, mark, inviter,
role), and rate limits lookups.

A code is short enough to read out, which makes it guessable, so three
things stand behind it. Guessing is slow: Bloks Cloud limits lookups,
and this computer limits guesses from its own network. A join password,
when the owner sets one (`PUT` and `DELETE /api/workspace/joining/password`),
is hashed with scrypt, checked only here, and never in the invite; five
wrong tries close that invite and tell the owner. And with Approve each
person on (the default), nobody is in until the owner has read the same
four words as the person asking (`POST /api/workspace/requests/:inviteId/approve`
or `.../decline`). The words are an HMAC keyed with the code's hash over
the joiner's device token hash and this workspace's join key
(`joinPhrase`), so a relay that swapped the key to read the request shows
different words on the two screens.

Joining is a sealed conversation about one thing. The joiner makes an
X25519 key and derives one key per direction with HKDF-SHA256
(`bloks-join-v1:joiner-to-host`, `bloks-join-v1:host-to-joiner`) against
the workspace's join key, then asks `/api/join/lookup`, `/api/join/claim`
(name, password, the device token's sha256, the kind of device),
`/api/join/status` and `/api/join/cancel`, through the relay's ask route,
or on the same network through `GET /api/join/key` and
`POST /api/join/ask`, where the link carries the host's address after the
code. Each ending has its own code: `wrong_code`, `expired`, `cancelled`,
`used`, `closed`, `declined`, `password_required`, `wrong_password` with
the tries left, `already_member`, `full`, `rate_limited`. An approved
claim answers with the person's id and role, the relay to use (or none,
and the owner's network address instead), and a welcome naming the
agents. The device token never leaves the joiner's computer; the host
keeps its sha256, as with pairing. On a Mac, `server/join-client.ts` is
the joiner's half, behind `/api/joining/...` for the window, and the app
keeps the result as a joined workspace.

`GET /api/workspace/members` gives the Members page everything at once:
the workspace, who is asking, each member's role, devices, solo agents,
spend this month and limits, the waiting invites, the joining settings,
the plan and the limit. `PATCH /api/workspace/members/:id` changes a role
(which ends that person's sessions) or limits, and `DELETE` removes them.
`GET /api/workspace/waiting` is the count for the switcher's dot.

### Limits, the plan and the owner's name

Every turn a member starts runs on the owner's engines and keys, so it is
the owner's bill. Per member (`server/member-limits.ts`,
`member-limits.json`), the owner and admins set a monthly limit on what
API keys cost, a share of Bloks AI's month, how many solo agents they may
make (three unless changed) and which engines those may use. Usage is
booked to whoever started the turn (`personId` in `usage.json`), and a
Bloks AI call carries the member's hashed tag, never a name. A member at
their limit has their own requests refused with words saying why and who
can raise it; nobody else notices.

Members are Bloks Team's (`server/plan-limits.ts`). The owner's plan
comes from the relay when this workspace is online, else from the
licence checked with bloks.dev (`server/owner-plan.ts`, kept in
`owner-plan.json`), and an unanswered check keeps the last answer, so a
network blip never throws anybody out. Not on Team, inviting, claiming
and approving refuse with `402 team_required`, and members already in
are paused: every member route answers the same 402, except
`GET /api/member/workspace` (which says `paused`), health and leaving.
Nothing is deleted, and all of it returns with the plan. A room shared
through its own invite takes new guests on Team, or on an older Cloud
licence the relay says holds a shared room.

Nobody else may see "The owner". The owner's name is kept in
`config.profile.name` (`server/owner-name.ts`): setup asks for it,
prefilled from this computer's account, and lets it be skipped; making a
Team workspace, sharing a room and inviting somebody refuse with
`409 name_required` until there is one, and the window asks there and
carries on. Agents are told the name in the owner's own conversations.
In conversations people go by their first name, with a last initial where
two in one workspace share it.

## Read positions

How far each person has read each conversation, room or agent lane, is
kept in `reads.json` (`server/reads.ts`): the last message they had on
screen, per person, the owner as `owner`. A position only moves forward,
because a person reads from more than one device in no particular order.
Agents never write one. The owner's window says its own with
`POST /api/threads/:threadId/read` once the messages have been on screen
with the window in focus, a member's with
`POST /api/member/threads/:threadId/read`, and each is broadcast as a
`read` frame and carried on the history routes, so a fresh load shows
them. Who sees whose is `readsShown` in `server/access.ts`: in rooms and
team conversations everybody sees everybody's; in a private conversation
its person sees their own, and the owner only while reading private
conversations is on, never an admin. Seen by is drawn only where at
least one other person is in the conversation, and never under the
reader's own message.

A room, or a team conversation with another person on its list or
speaking in it, draws every message as a bubble, with a face and a name
on the others' and runs from one sender grouped; a chat with one agent
keeps its full width prose.

## Shared files

An agent's deliverables folder (`server/artifacts.ts`) is the one place a
file is served from, and a name is a path inside it, folders included
(`reports/q3.pdf`). Every name is judged twice: as words (no `..`, no
hidden segment, no backslash or control character, decoded once before
judging, so `%2e%2e%2F` is a climb), then as the file it really is, with
links followed, which has to land inside the folder. A link out is a file
that is not there. `GET /api/bots/:id/artifacts/:name` takes the name
encoded as one segment or with its slashes, answers byte ranges (a
`Range` header, which a video player seeks with, or `?range=` for Bloks
Cloud, which carries no request headers), and names a download in
RFC 5987 form so any character survives. `GET /api/bots/:id/artifacts`
lists the folder, folders included.

The sweep at the end of a turn still cards only new files at the top of
the folder: a turn that writes a site with forty images in a folder
should not leave forty cards. Anything else reaches the chat by
`bloks share <file> [--as <name>]` (`POST /api/bots/:me/artifacts`). A
file already in the folder, nested or unchanged since before the turn,
is carded where it is. A file anywhere else is read by the command, as
the agent and inside whatever sandbox it runs in, and its bytes are
streamed in under a free name (`q3 (2).pdf` beside an existing `q3.pdf`),
written to a hidden file and renamed in once complete. The route never
opens a path it is handed, so sharing cannot become a way to read the
disk. Only this computer can share in. The answer carries the card's
`href` and a markdown link to write in the reply, and the shared file's
fingerprint goes into the turn's baseline so the sweep does not card it
twice.

A link in a reply that is the file route, a path or a `file:` URL is a
`file` token in `src/lib/inlineMarkdown.ts`, never an `<a>`. Clicking it
asks `GET /api/artifacts/resolve?path=` what it is: a path inside some
agent's folder (lexically or after links are followed) answers that
agent and file, and anything else answers 404 with `shared: false` and a
sentence saying to ask the agent to share it. A code span reads as a
file only when it looks like a path in a deliverables folder, so the
paths in a coding conversation stay text. Card and link open the same
viewer: PDF, image, video (no autoplay; an unplayable format says so and
offers the download), Markdown rendered with its source a click away,
text, tables, HTML in a sandboxed frame. A failure says why and offers
Try again, which asks for the file again and never starts a turn.

Access is the artifact route's: an owner's device on this computer, the
network or Bloks Cloud reads any agent's files, a member of a shared
room is shown a card's name and nothing it could open, and an agent's
credential lists and shares into its own folder only and cannot resolve
paths. A phone reads `shared-files` in `/api/health` before offering
nested names, ranges or path links; through Bloks Cloud it takes a file
a range at a time, since one answer has to fit the relay's payload.

## Rehearsals

`server/rehearsals.ts` clones the agent's folder (copy-on-write with
`cp -c` on APFS, `--reflink=auto` on Linux, a plain copy elsewhere) and
runs the turn in a lane of its own pinned to the clone. The checkpoint is
taken between the real folder before and the clone after, so the card is
the same one undo uses, marked as a rehearsal. `/api/checkpoints/:id/apply`
writes each file only if the real one still matches what it was when the
rehearsal began, then the record undoes like any other; applying one
attempt of a compared task discards the rest. Copies are deleted when an
attempt is applied or discarded, and swept after a week. Attempts are
listed on Overview, the whole width below the brief, and a ready one
puts a dot on Overview in the main rail.

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

## Redo

Saving an edit to a message only rewrites its stored text; the agent has
already read the old words. `POST /api/threads/:lane/messages/:id/redo`
with the new `text` is the edit that reaches it, in one call: the lane is
claimed, the running turn is stopped and waited for (and its change
card, since a turn's files are on record only then), the lane is rewound
with the rewind's own function, and the words are sent. `GET` on the
same path is read-only and says what that would take back (messages,
files as the folder stands now, whether a turn sent anything that
stays), or that it is not offered and why; the app's line under the
editor is those numbers. A refusal before the rewind takes nothing back.
A send that fails after it answers `sent: false` with the words, which
is what a rewind leaves.

Where it rewinds to is in `server/redo.ts`, read from the transcript
alone. A checkpoint covers a whole turn, so a message said into a
running turn (`joined`, written when the turn takes it) goes back to the
message that started that turn, and the person's messages from the turn
are sent again in order, as one burst through the lane's queue. A
message still waiting (`queued`, `unsent`) is refused, as are words that
are not the person's own typed here (`agent`, `via`, `fromTelegram`) and
a message that joined a turn somebody else started. What waits above the
composer is not taken back; it goes after the redone words.

## Backup engines

`server/failover.ts` reads a failed turn's runtime errors and stop
reason for what kind of failure it was (`failureOf`): its engine being
out (a usage or rate limit, no credit, an outage, signed out), a safety
refusal by the provider, or anything else. For an engine that is out it
also reads when it should be usable again (an epoch, "try again in
20m", "resets 3pm", or a default per reason, capped at twelve hours).
The engine rests in a per-instance table in memory, so every agent on it
skips it until then. A stop, a stalled tool, a command and a
conversation too long for the model (folded and asked again on its own)
are not failures here.

What happens to a failed solo turn (GitHub 284) is decided at its end
(`recoverTurn` in `server/index.ts`), once per message. A refusal is
asked again at once in a new session told the bounded story (see
Compactions), and the refused session is dropped (`store.dropSession`:
its cursor goes and `lastInstanceId` is emptied, so whichever engine
comes next is told the conversation); a refusal in a session that was
already new is not asked again. An engine that is out is not asked
again. Anything else is asked again once in the same session after
`RETRY_WAIT_MS` (a minute; `BLOKS_RETRY_WAIT_MS` in tests), with the
lane kept busy so new messages queue; Stop, an archive or a hold cancels
the wait. When the retry fails, or there was none to make, the backup
takes the message once, with `fallback: true`, for whoever asked: any
`backupSelection` that is usable and is not what just failed (another
engine, or another model on the same engine, which resumes the same
session; after an engine that is out, another engine). When nothing can
take it, the raw errors are shown as they were, one notice says why (no
backup and where to set one, the backup unavailable, or both errors when
the backup failed too), and the lane is marked for the person. The raw
error is held back while a turn may still go on and said in the notice
that says what happens next.

After the backup answers, that lane stays on it (`stays`) for `STAY_MS`
(half an hour; `BLOKS_BACKUP_STAY_MS` in tests), or until the own
engine's rest ends when it rests; the person changing the agent's engine
or backup ends it. The own engine's stored session is remembered as away
from the lane (`away`) from the first message another engine answered.
When it serves the lane again it resumes that session and is told only
the messages it missed (`catchUpText` in `server/turn-context.ts`),
unless it has no stored session or what it missed would not fit a new
session's bounded story, and then it starts a new session told the story
as any engine switch does. Each turn after a failure (the retry, the
backup, the first turn back, the next turn after a stop or after the
agent gave up) opens with one line in its own words saying what failed,
when, on which engine and model, and what Bloks did (`failureNotes`).
All of this is in memory: after a restart the own engine is simply tried
again.

A Fast Codex turn that cannot have Fast (see Codex speed) is refused
before any words reach the model, and its end carries `preInputRefusal`.
It is not an engine failing: nothing rests, it is not asked again, and
the session is kept. A backup takes it once if there is one that might
run Fast (not Codex on a Box or Boat); otherwise it ends unsent, the
reason said once, and whatever waited on it (a routine's run, a Telegram
reply) hears that reason. Standard turns never meet this refusal.

Room turns are not asked again or handed over, since they belong to the
room's order of speakers. The error shows in the room, an engine that is
out rests so the agent's next room turn uses its backup, a refused
session is dropped, and the agent's next turn is told what failed. A
turn that answers ends a sign-in rest on its engine early, since the
login works again.

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

## Engine pauses

The owner can pause an engine or a model for a while
(`server/engine-pauses.ts`, based on GitHub 305): a family of models
(every Anthropic one, told from the model's id and the engine serving
it, `familyOf`), a kind of engine (every Codex), one configured engine,
or one model, for every agent or for the ones named, until a time. Every
pause has an end, a week at most. Nothing about any agent's engine or
backup is changed, so there is nothing to put back when it ends. The
owner adds, sees and ends pauses in Settings, Engines and keys, Pauses, here or
from a paired device (`/api/engine-pauses`, feature `engine-pauses`). An
agent may pause only itself, for a day at most, and sees only the
pauses that cover it, with no other agent named (`bloks pause`,
`bloks pauses`, `bloks unpause`); it ends only its own. A shared room's
members never reach any of it.

One door decides: `selectEngine` passes over an engine paused for the
agent, as it passes over a resting one, for the agent's other engine
when that one may go (a turn handed to the backup has only the backup),
and `startTurn` holds a turn whose engine is still paused. With no pause
saved, the door is one length check: nothing is read, written or
recorded per turn, and no turn behaves differently. The list is read
once at start and written, atomically, only when a pause is added or
ended; ended pauses are dropped then.

What a pause holds waits where it would wait for a busy lane or a drain,
and goes on its own when the pause ends (a timer at its end, with the
routine tick as a backstop, `releasePaused`), or as soon as it is ended
early. Words for one of the agent's lanes wait in that lane's queue, on
disk, shown above the composer as waiting for the pause and until when
(`waitsFor: "pause"`, `waitsUntil`); the conversation says once that it
is held. Room lines wait as they do for a busy agent, and the room is
told once (in a shared room, only that the agent is paused and until
when). A routine is recorded as held without spending its slot, as at
the chain limit, and runs when the pause ends if that is inside its
missed-run grace, otherwise at its next time; run by hand it is refused
with the reason. A watcher holds without looking, so the change is
still there for the first look after. A job goes to someone free, or
waits open on the board. A workflow's ask step waits and the run says
why. A webhook's event waits in the lane, and an email in its line.
Summaries, skill reviews and a goal's judge are not asked of an engine
paused for the agent. A retry, a backup handover, a pickup after a
restart, a rehearsal and a member's request are refused with the
reason, which shows where they would have run.

A turn already running when a pause starts finishes on its engine,
unless the owner chose "Also stop what is running on it now": then it
is stopped as by Stop, with a notice saying why, and not picked up after
a restart. An agent cannot stop anything with a pause.

A saved file that cannot be read never stops work it does not name. The
pauses that can be read still hold; the rest are left out, the file is
copied aside as `engine-pauses.json.corrupt-<time>`, and Settings says
so. A file that cannot be opened at all holds nothing, and new pauses
are refused until it can be, rather than written over it. A lane's queue
after a restart follows the queued-message rule: words older than twelve
hours are marked not sent rather than run.
## Codex speed

Codex runs at Standard or Fast (`server/codex-speed.ts`). The workspace
has a default (`codex.speed` in the config, Standard when unset) and an
agent may have its own (`codexSpeed`; null follows the workspace). One
choice covers the agent's primary and backup Codex. It is resolved once,
when a turn is dispatched, and handed to the driver with the turn; a
steer or a setting changed mid-turn applies from the next turn. An agent
may read its speed (`whoami`) and set its own to Standard or back to the
default, but not to Fast, which spends the person's plan faster; Fast
and the workspace default are the owner's.

Standard is Codex as it always ran: nothing about the tier is sent, so a
Codex older than the field works unchanged, and a host or project config
of Codex's own still applies. Fast asks for the priority tier on
`thread/start` or `thread/resume`, with `features.fast_mode` on for that
process, and goes ahead only when the answer names `priority`. A Codex
that leaves the tier out of its answer, names another, or rejects the
field refuses the turn before input, saying to update Codex or choose
Standard. A model the catalog said within five minutes has no Fast is
refused before a process starts. Codex on a Box or Boat cannot be asked
for a tier yet, so Fast is refused there before the box is woken;
Standard runs there as before.

While a Fast turn, or one at an agent's own choice, runs, its lane
carries `codexDispatch` (the choice and the tier Codex said it
configured; Codex never reports the tier that served), and the desktop
shows a line for it. Standard by the workspace default carries nothing,
as before. It is never a message and goes when the turn ends. The phone
checks the `codex-speed` feature before offering the choice.

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

The restart itself is a chain, and every link in it has a time limit
(`electron/update-restart.mjs`): one more look for a newer release, the
drain, the native installer having the update, then the quit that hands
over to it. A link that fails or runs out of time does not stop the
next. Once the drain is past, nobody can call the restart off and the
process ends: by the orderly quit when that works, by closing a window
that stayed open ten seconds later, and by a plain exit ten seconds
after that. On macOS the installer swaps the app only once the running
one has gone, so an app that does not exit is an update that never
installs. Each step is written to the updater's log (`updater.log` in
the app's log folder), each line starting `restart:`. Before the quit a
note of the version being left goes into the app's data folder, and a
start that finds itself still on that version says on the update card
that the update did not install, once, with the offer to try again or
to get the installer from bloks.dev.

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

## When the window fails

The servers and every agent keep working whatever happens to the window,
so the window is what comes back. A page process that dies loads the app
again (`electron/renderer-watch.mjs`); three deaths inside a minute show
a plain page with a Reload link instead of a loop. A page that stops
answering is waited on and written down, never killed. In the page, an
error boundary under the whole interface (`src/components/ErrorBoundary.tsx`)
puts a calm panel in its place when any part throws while it draws, with
Reload and the details to copy, instead of an empty window, and says so
to the app log.

That log is the app's own (`electron/app-log.mjs`): a few lines about the
window and its processes, a helper process that went away and why, in
`app.log` in the app's logs folder beside `updater.log`, moved aside to
`app.1.log` at 512 KB, never in a workspace's folder and never sent
anywhere. What the page asks to write is budgeted (`lineBudget`). A native
crash leaves a minidump in the computer's crash folder: the crash
reporter starts with `uploadToServer: false`, and there is no server to
send one to.

## Backups and restore

`server/backup.ts` writes the whole data folder to one file in
`~/.bloks-backups` (0700), named with the local date and time, the
version, and `-auto` or `-before-restore` for those kinds. It is a
gzipped tar, so any archive tool opens it: `bloks-backup.json` first (the
format, version, time, kind, and whether the Undo history and saved keys
are inside), the workspace under `bloks/`, and `manifest.json` last, with
every file's size, mode, time and SHA-256, written last so each file is
read once and hashed on the way through. A file is read from an open
handle up to the size it had when opened, which is one whole version of
a store (stores replace their files by rename) and a clean prefix of a
log being appended to. Left out, and named in the manifest: `native/`,
browser profiles, rehearsal copies (their `index.json` stays), caches,
dependency folders anywhere (`node_modules` and friends, never `.git`),
temp files, sockets and links, the server's `server.lock` and `port`,
and `checkpoints/` unless the Undo history is asked for.

With a passphrase the archive is sealed: scrypt (N 2^17, r 8, p 1) gives
an AES-256-GCM key, and the archive goes in pieces of a megabyte, each
with its own nonce and bound to the header, its number and whether it is
the last, so a piece changed, moved or cut off fails to open. The header
stays readable, with the summary and an HMAC of the key, so a list needs
no passphrase and a wrong passphrase is told apart from a changed file.
Saved keys in `config.json` (the paths in `SECRET_PATHS`, paired device
digests included, since the relay's keys come from them) go only into a
sealed backup; otherwise they are taken out of the copy and the manifest
lists where, and old copies such as `config.json.corrupt-*` stay out too.
Verifying reads a backup end to end and holds each file to the manifest.

The daily backup is looked for every ten minutes and made when nothing is
running (the drain's own idle test), no drain or other backup is under
way, and the newest automatic one is a day old. The newest seven are
kept; manual backups and the ones taken before a restore are never
pruned. It is on unless `backups.auto` is false, and never holds keys.

A running server holds every store in memory and writes it back on each
change, so a restore never swaps the folder under it. The routes
(`/api/backups`, this computer only, never a paired device or an agent's
credential) take it in steps: open the backup far enough to know it is
one and the passphrase is right, drain (ten minutes unless asked), back
up the workspace as it is (`-before-restore`), unpack the archive into
`~/.bloks.restoring-<time>` beside the data folder and check every file,
then write `~/.bloks.restore-pending.json` and stop the server the way a
quit does. `server/pending-restore.ts` is the first import of
`server/index.ts`, so on the next start, before any module reads the
folder, it renames `~/.bloks` to `~/.bloks.before-restore-<time>` and the
unpacked copy into its place; it waits while another live Bloks holds the
folder, and a swap that cannot finish puts back what it moved. A backup
without keys gets this computer's keys carried into its `config.json`.
Paths in an archive must stay under `bloks/` with no `..`, links and
devices are refused, and nothing is written for an entry that fails. The
desktop page relaunches the app when the server says it is restarting,
and a browser waits for a new pid. `bloks-server backup` writes from its
own process, and `bloks-server restore FILE` does the whole thing with
Bloks stopped, or copies the file into the backups folder and hands it to
the running server.

## Queued messages

What the person says to a lane in the middle of a turn is read first
(`server/delivery.ts`, `deliveryFor` in `server/index.ts`), from the app
and the phone; Telegram follow-ups and words typed into a card skip the
reading and go in as described below. Each agent has a delivery mode
(`BotRecord.delivery`, `PATCH /api/bots/:id` with `auto`, `interrupt`,
`queue`, or `null` to follow the workspace; never from an agent's
credential), and the workspace has `delivery.mode` in config.json
(`PUT /api/config`, Settings, Behaviour), Automatic when unset. Automatic
reads the words by rules: a short stop stops the turn, and the message
starts the next one; "wait", a correction ("no", "actually",
"instead"), urgent words, or a short reply to a question the agent's
latest words in this turn asked go in now; words that say they are for
afterwards, and everything else, wait. Only words the rules have
nothing to say about are put to a model, only when the person turned
that on (`delivery.askModel`, off by default, since each ask is a call
on their key), and only to the agent's own engine when it has a small
one (`ProviderInstance.smallText`, an
OpenAI-compatible provider's named small model), for at most 1.5
seconds; no answer means wait. Interrupt sends everything in now (a
stop still stops), which is how every message went before modes
existed, and Queue waits whatever the words. The person's one tap
(`delivery: "now" | "wait"` on `POST /api/bots/:id/messages`) outranks
both. Going in now uses the steer below; an engine with no `steerTurn`
is stopped instead (`stopForYou`) and the message starts the next
turn, but only for the person's own turn in its own lane
(`mayStopForWords`). What happened is kept on the message
(`Message.delivery`: route `steered`, `stopped` or `queued`, why, and
the line said under it, such as "Queued until Research Analyst
finishes" or "Interrupted to take your correction") and returned on the
send. `POST /api/bots/:id/delivery` says, by the rules alone, which way
words would go before they are sent, so the composer can say so with
Send now or Wait instead beside it. `POST /api/bots/:id/queued/now` is
the flip afterwards: the person's waiting words go into the running
turn as themselves, in order (`sendWaitingNow`, moved rather than
copied), or the turn stops for them when the engine cannot take words
midway. Words that wait on purpose do not hold back a correction sent
after them; words that wait only because they could not go in still
do.

When words go in now, they go into that turn when its engine can take
them (`steerLane` in `server/index.ts`). Claude Code keeps the stdin
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

Command/Ctrl+Enter in the app stops before submitting the follow-up
(`src/lib/sendMessage.ts`). When a conversation is named, both requests
name it. It waits for `/interrupt` to answer, then sends the message with
`steer: false`. Stop acknowledges the request, not necessarily the engine's
exit, so the message waits in the normal queue until that turn settles
instead of joining the dying turn. Either request's failure uses the normal
draft recovery; a failed Stop submits nothing. Plain Enter still steers.

An empty composer receives failed text and attachments back immediately.
If newer words or chips occupy it, `src/lib/drafts.ts` retains the failed
payload separately under that conversation's existing draft key. The
composer lists each saved submission with explicit Restore/Discard actions.
Restore fills an empty box and never sends; an occupied box keeps both.
Accepted input and recovery update the current draft synchronously before
React renders, so batched failures cannot replace one another. This stays
in window memory across conversation navigation, not reload or restart,
and does not imply the server failed to receive a message whose reply was
lost. Room composers keep their existing draft contract.

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
included. A message that would start or wait for a turn past the
workspace's `agents.turnLimit` is refused, with no message kept for
later delivery. It defaults to twelve (`MAX_AGENT_CHAIN` in
`server/agent-chain.ts`) and takes a whole number from 1 to 50; there is
no Off, because the whole-chain count is the bound on cost. Settings,
Behaviour exposes the live setting. A malformed
stored value reads as twelve, and one above 50 as 50. The recipient's
notice names the undelivered item or skipped run, the reached limit, its
cost reason and where the limit is set. It does not say that the task
failed or that the person must continue it; the sender is told to finish
its turn and report any unfinished work. Whoever the person writes to
next starts over at 0, whether their words start the turn, join it, or
are among what it takes when it goes. A burst of waiting messages takes
the furthest place among them, and a pickup, a backup engine or a retry
keeps the place of the turn it continues. The places live in memory,
with the queue they ride on, rather than on the lane record: a restart
begins every chain again, which lets a loop that spans one run a stretch
more at most, and leaves nothing on disk to clear when a lane closes.

Separate tasks are counted apart only when the person allows it
(GitHub 326). `agents.taskBudget` is off until they set it in Settings,
Behaviour, to a whole number from 2 to 100; an agent is refused the
config route like any other setting. An agent can name the task a
message hands off (`bloks say --task <name>`). The server keeps, beside
each lane's place, the task its turn is on (`chainTasks`) and where in
the chain that task's handoffs started, which is always the sending
turn's own place and never anything the agent says: a message naming a
task other than its turn's starts that task there, and one naming none
goes on with its turn's. With a budget, a turn on a named task counts
its task's own run against `agents.turnLimit` and the whole chain
against the budget; a turn on no named task counts the whole chain
against the limit, as without one (`chainPast` in
`server/agent-chain.ts`). So a reviewer moving from one task to the next
is not held as one exchange, a loop on one task is still held at the
limit, and a loop of any number of agents that renames its work every
time is held at the budget. The notice says which bound held it, the
task by name or the budget as the person's own. A burst keeps a task
only when every agent's message in it agrees on one, and routines,
watchers, jobs and room mentions an agent sets going carry only the
chain's place, so they count the whole chain against the limit.

A turn's own budget is twelve general changes and one more kept back:
past the twelve, the only change a turn may still make is one direct
message to another agent, so an agent that spent its twelve on the work
can still say what it did (`claimReport` in `server/agent-cli.ts`). Not
to itself and not to a room, and the chain limit still applies to it,
so the thirteenth cannot keep a loop going. The kept-back message gets a
receipt, held on the credential through its renewals: the same words to
the same place, sent again, read that receipt (accepted, queued or
steered, with the note and the engine-readiness warning any message
gets) without delivering anything a second time, and different words
are refused. A refusal before anything reached the recipient leaves the
slot free. One that might have arrived (the engine's pipe closing
mid-steer, say) is answered as uncertain, keeps the slot, and is never
queued again; Codex answering a steer with an error is a definite no,
and the message waits for the next turn as any other does.

Rooms and the job board carry the count too, or an agent could keep
another going through them. An agent naming someone in a room, from the
room or from a conversation, hands the turn it wakes a place one past
its own; past the limit nobody is woken and the room says why. A room
also keeps the latest such place (`roomChain`) for a turn that waited,
behind a busy agent or a round, and anyone but an agent posting there
clears it as the post goes out. A job posted from an agent's turn
records the place its taker's turn would take; past the limit it is not
offered, and the person offering it again clears it. Routines and
watchers an agent files or changes do the same (`chain` on each): past
the limit a routine's attempt is recorded as held without consuming its
scheduled slot, and a watcher holds without looking. When the live value
allows, an enabled routine runs at its next allowed occurrence under its
existing missed-run grace, and a watcher rechecks on its next arm,
clearing the stale error on a good look. A once routine disabled by
older code is not revived. A once slot past grace stays enabled but
needs a manual run or deletion; it still counts against the routine
limit. One latest hold record is kept beside the normal run history, so
repeated holds cannot evict real runs. Agents cannot file workflows. A
room has a shorter bound of its own as well (`MAX_AGENT_HOPS`, see
Rooms), carried with the turn the same way; a mention past both leaves
one notice in the room, not two.

Changing the limit changes where the line is, never the count: a running
turn keeps its place and is judged by the live value at its next handoff.
The setting API stays unavailable to agents and to a shared room's
members.

A refusal is said where the person will find it
(`chainNotice`): a notice in the conversation the next turn would have
gone on in, naming the whole count and its last step, that conversation
marked unread. The record does not wake the phone or raise a desktop
banner: a mechanical hold does not itself ask the person to decide.
A routine or a watcher says so once when its hold starts, not at every
tick or look. Direct refusals dedupe consecutive notices by sender,
recipient, depth and limit, ignoring the redacted excerpt. A person's
message between refusals allows a fresh notice. These notices retain
`chainHeld` and explain the limit in the conversation.

## Goals

A conversation can be given a goal, and then keeps working turn after
turn without anyone typing "keep going": what done looks like, a command
that has to exit 0 for it to count (optional), and how many turns it may
take, twenty unless the person says otherwise and a hundred at most.
`/goal` in an agent's chat sets one, with `check:` and `turns:` on lines
of their own; on its own it opens the same dialog as Set a goal in a
conversation's menu, which is `PUT /api/bots/:id/tasks/:taskId/goal`
(`PATCH` pauses, resumes or gives it more turns, `DELETE` clears it).
`/goal` is Bloks' own: the messages route reads it before anything
else, so it never reaches an engine, where a command of that name would
run as one. The goal lives on the lane (`TaskRecord.goal`), goes with it
when the lane is closed or cleared, and `clientBot` ships a summary for
the chip over the composer.

Each turn in the lane that ends well is judged (`judgeGoal` in
`server/index.ts`; the rules and words are `server/goals.ts`). The check
runs first, in the lane's folder, through the shell as a watcher's check
does (`runCheck`): its own process group, stopped after five minutes,
the end of its output kept. Then the agent's own engine is asked once,
through the one-shot call a fold uses (`generateText`), for a verdict as
JSON: done, continue or blocked, with a reason and a next step. With no
small model, or an answer that is not a verdict, the check decides, then
the agent's own last line ("Goal: done", or "Goal: blocked," and what it
needs), which every goal note asks for. Done needs the check to pass,
whatever the judge read. Done and out of turns end the goal with a
notice; blocked hands it back with what it needs and the lane reads as
waiting on the person; continue queues the next turn.

That turn goes in through the lane's queue (`queueGoalTurn`) as a
message marked `via: "goal"`: a note from Bloks, never the person's
words, so it names no skill, runs no engine command, and keeps the chain
place of the turn it follows (see Agents writing to agents), and the
chat labels it as Bloks'. It is counted before it is queued and none is
queued past the budget, so the budget is a hard cap whatever the judge
says. The person comes first. Whatever waited for the lane goes before
the goal is judged, and a verdict is acted on only while nothing waits
and no other turn has started in the lane since the one it judged
(`laneTurns`). The person's Stop pauses the goal and takes back a next
turn already queued; their answer to a blocked goal picks it up again
after the turn that hears it; a turn that fails pauses it. A turn picked
up after a cut off, handed to a backup or asked again after a fold is
not over yet, and is judged when it is. A room's turn or an engine
command in the lane is not the goal's work, but the goal is judged after
it on the lane's own last reply rather than left with nothing to start
its next turn. Goals stay out of shared rooms' lanes, the lane for
unlisted mail and rehearsals. One left active after a restart with
nothing running or waiting in its lane was between turns when Bloks
stopped, and is paused rather than judged again unattended.

While a goal runs, its turns' replies raise no banner. Done and out-of-
turns notices follow the agent's reply switch. A goal is judged blocked
only when it cannot go on without the person, so its notice raises an
urgent banner past that switch ("needs you") and wakes the owner's phone,
the same as an unanswered question or approval card, including a
workflow gate. A chain hold never does, whatever its words. An agent reads its goal with `bloks goal`
(`GET /api/agent/goal`, which reads the goal of the lane its credential
was minted for), and nothing on its list reaches the routes that set
one.

## The same call, again and again

An agent that has lost the thread can call one tool with the same
arguments over and over, and every call sends the whole session to the
model again. A driver that hears a call's arguments puts a `signature` on
its `item.started`: the tool and the arguments, normalised (keys in
order, runs of spaces made one) and hashed (`callSignature` in
`server/repeats.ts`), so the arguments, which can carry a key, ride on no
event. Claude Code gives `block.input`, Codex the item's own request
fields (a command and its folder, a patch's changes, an MCP call's server,
tool and arguments, a search's query), an ACP agent its `rawInput` when it
is not empty, and an API model the arguments it wrote. Antigravity and the
cloud computer name the tool and nothing more, so their calls are not
counted.

`RepeatWatch` counts each running turn's calls by signature, from nothing
at every `startTurn` and forgotten at its end. When a call reaches 5, 10
or 20 and that is higher than the turn's chip, its activity row gets
`repeated` and the row that had it loses it (a `message.patch`), so a turn
shows one chip, "Same call repeated 10 times", on the run of tool calls
it sits in (`src/components/ToolRun.tsx`). The first call to reach 20 also
posts one notice saying the turn may be stuck and can be stopped. Nothing
is stopped for the person. The notice does not name the call, since a
shared room's members may see only a tool's kind. Memory is bounded: a
turn keeps 256 distinct calls, forgetting the one used longest ago (never
the loop, which is the call it keeps making), and 512 turns at most.

## A finished turn, folded

While a turn runs the chat shows everything it does. Once it has ended,
what it did on the way folds into one line above its result ("Worked 8
min · 27 commands · 4 files", then the agents it wrote to), and a click
opens the work in place. Under the fold go its progress messages, tool
calls, rows for messages to and from other agents, the message that
started it when that was not the person's (another agent's, a routine's,
a watcher's, a webhook's, a goal's note), cards already answered, the
screen it ended on and the changes card. Left out are the person's own
words, the turn's last reply, cards that still wait for them, artifacts,
components and every notice. Quiet check-ins and messages taken back
keep the rows they have. `src/lib/turnFold.ts` decides all of it from
the transcript, and no fold is stored.

A turn begins at a message with `role: "user"` and ends where the next
one begins; the last has ended when its lane is no longer working
(`turnRunning`, which takes a lane paused on a live approval as still
going). Its result is the last thing the agent said in its own chat.
The one thing the transcript could not say afterwards is that a message
went into a running turn instead of starting one, so `steerOne` marks
those `midTurn`. The person's words in the middle of a turn stay on the
page and split its work into a fold on either side. A transcript from
before the mark takes each such message as the start of a turn, which
leaves one more progress message showing and never hides a reply.

The line names who asked when it was not the person, and another
agent's name there opens the exchange, as the "After a message from"
link above the reply does while the turn runs. A turn that only wrote
back to the agent that asked is the line alone, ending in "replied".
The count is of commands when every call was one (`kindOf` in
`src/lib/tool-summary.ts`) and of steps otherwise, and of files only
the turn's own.

A room's transcript does not say where an agent's turn began, so there
a turn is what one agent did until somebody else spoke (`foldRoom`), and
`RoomView` remembers where a turn it saw start began, so nothing of it
folds while it runs. When a fold closes over a reader who is not at the
end, `useHoldPlace` keeps the reply where it was on screen; a find hit
or a forum link into folded work opens the fold.

Codex narration in a turn another agent started is work from the moment
it is said. Codex marks each finished message `commentary` or
`final_answer`; the server stamps a bot's text with `codexText` (shaped
in `shared/codex-text.d.ts`, stamped by `server/codex-text.ts`, feature
`codex-progress`) and the stamp says `display: "progress"` only for
commentary in a turn an agent started (`codexOrigins`: another agent's
message, a room handoff, never the person, a routine, a watcher, a
webhook or a recovery) that asks the person nothing. Codex 0.145 does not
say whether an item asks anything, so when it is silent the server reads
the text, and reads it one way: no question mark, nobody addressed, no
word a request or a blocker is made of, in a script it can read.
Anything else is `unknown` and shows as usual; Codex's own `questions`,
should it ever send one, wins. Progress makes no unread, wake, preview,
banner or speech. The client (`src/lib/codexProgress.ts`) folds it into
the work row while the turn runs and gives it back once more is known: a
person whose words joined the turn (`joinedTurnId`, set by `steerOne`
only when Codex accepted them into that turn) sees all of it, and a turn
that ended without an answer keeps its last commentary on the page. None
of that rewrites history or alerts again. A client that does not know
the field, or a newer version of it, shows the text as before.

## Desktop banners

What raises a banner is one pure function, `noticeFor` in
`src/lib/notify.ts`. An unanswered card, a blocked goal and an engine
that is out ("could not answer") interrupt as soon as their message
lands. A reply does not: a turn can save several, some of them running
commentary, and only its end says which one is the answer and whether
anything is to be said at all. So the server says it once
(`server/reply-notifications.ts`): each attempt keeps its last saved
reply, an explicit final answer before later commentary, and when the
turn is over, whether it ended well or not, a `reply.settled` frame
carries that reply, clipped to what a banner shows. Nothing is said for
an attempt that is asked again or handed to a backup (the next attempt
speaks for itself), a quiet check-in folded away, a Stop, an engine
command, or a turn on the way to a goal. The frame inserts nothing into
the transcript and is read against it first, so words deleted while the
turn ran are not said. `NoticeDelivery` keeps a replay or a reconnect
from saying the same thing twice.

The desktop in remote mode can be newer than the computer it works with.
On every hello it reads that server's features (`/api/health`), and one
without `reply-settled` has its replies announced as they land, at most
one every four seconds in a conversation, as before.

## Chat platforms

A shared room can be carried into Slack, Discord or a WhatsApp group
(`server/chat-bridge.ts` holds the rules, one transport file each moves
the bytes). Slack and Discord are connections this machine opens. WhatsApp
can only call a public address, so Bloks Cloud gives each workspace one
and hands every call over the relay line as an ask; the call arrives
readable, because Meta sends it that way, and is believed only if Meta's
signature checks out against the app secret, which stays here.

## Telegram

The person can reach an agent from a Telegram bot that is that agent's
own (`server/telegram.ts` holds the rules, `server/telegram-bots.ts` the
saved shape, the Telegram parts of `server/index.ts` the plumbing). A
bot is a BotFather token in the agent's settings
(`GET`/`POST /api/bots/:id/telegram`, never with an agent's credential,
and the token never comes back out). An agent without one is not on
Telegram, and one Telegram bot cannot be given to two agents: the token
is checked with `getMe` and its bot id compared with every other
agent's. Each bot that is switched on has its own long-polling loop
(`TelegramRuntime`), so nothing listens on a port.

An agent that made a bot for itself with BotFather asks for it to be
connected: `request_secret` with `telegram_bot`, or `bloks telegram
connect @name` (GitHub 329). The secure card names the agent and the bot,
and the owner's paste is the approval (`connectTelegramBot`): the same
`getMe` and one-bot-per-agent checks as the settings field, and the token
must belong to the bot the card named. It goes to that agent's Telegram
settings, never into its environment or the conversation, and the agent
never sees it. Only the agent's own conversation with the owner can plant
one, only while it has no bot, and its credential can neither save the
card nor ask for another agent's bot. Pairing stays the owner's: the word
waits in the agent's settings, as after pasting the token there.

Everything hangs on the pairing. The owner is the Telegram account that
sends the single-use pairing word to the bot in a private chat, kept by
its user id (`ownerUserId`), since a chat id or a display name says
where a message came from and not who wrote it. The word is made with
the system's random source and is good once. Another person's first private
or addressed group message creates one owner-only admission card and one waiting notice. Group notices reply to the captured addressing message and topic; the first admitted message keeps that destination. A private chat is learned only from a private message. Let
in, Not now and Take out are per person and per bot. The card names them
beyond the first name they chose: their Telegram user id, their @username
when they have one, what they wrote, and anyone else on the bot with the
same name; marks that reorder or hide text are stripped from the name. The
first message is bounded and media is not downloaded before admission.
Declining tells a private sender once; a group decline causes no later group
notice or invented DM. Later messages do not create another knock. Guest mail and
shared rooms keep their own paths.

An admitted person's message is labelled with their name, Telegram and its
group when present,
and runs in the agent's first conversation with its own requester. It waits
behind an owner or another person's turn; only the same requester and audience
can steer its running turn. The audience includes the group and topic, or
private. Each queued segment retains that requester, audience and grant.
The owner's app words, private DM and another agent's say cannot join an
owner group turn. Queues, fallback, retry, Continue and restart retain their
server-created group provenance; a stale return never becomes private owner
input. A merged segment replies to its last addressing message, and later
steers keep that anchor.
Taking someone out or retiring a bot transport revokes pending words,
approvals and reply capabilities before interrupting that person's turn.
An owner's turn is left alone. Admission is bounded to 100 waiting or let-in
people and 20 waiting; a full inbox holds new people visibly. Declined and
removed people do not count toward it, and past 100 of them the longest
closed is forgotten and may knock again.

Full access (GitHub 320) is a separate grant the owner gives one let-in
person on one agent's bot, in that agent's Telegram settings (`full` on the
person; actions `full` and `restricted` on the Telegram route, never with an
agent's credential). Nothing gives it automatically: letting someone in, or
back in, is restricted, and the default for everyone else is unchanged.
Their words carry their sender (`telegramDelegate`) and run as the agent's
ordinary turns, with its own tools, engine and permissions, Codex included;
the agent is told they are not the owner, and recall and the summary keep
them as theirs. The running turn's sender (`laneTelegramDelegate`) keeps it
theirs: only they add to it, their words join no other turn, and waiting
words from different senders are separate turns (`queuedSegment`). A retry,
a backup or a pickup reads the sender back from the conversation. Its
answer, notes, files and cards go only to their chat (`fullAccessInbox`),
where only they answer those cards; admission cards stay the owner's, and
the owner sees, answers and can stop everything in the app. Every change to
the grant makes a new one, so their waiting words are dropped, their cards
denied, their turn stopped and its credential revoked, and nothing more of
it reaches them; what is done stays done. The conversation and memory are
still one, shared with the owner, which the settings say before the grant
is given. During a drain they are asked to send again rather than held.

Groups accept only an outer mention entity whose whole UTF16 slice matches
this bot's username (case-insensitive), a text mention of its numeric bot id,
or a reply to an ordinary message from this bot in the same chat.
`/cmd@this_bot`, external replies, quotes and forwarded entities do not
address it. Bots, anonymous sender chats and automatic forwards are ignored.
An unaddressed update advances the polling offset without a transcript entry,
knock, file fetch or logged message text. Replied-to context is bounded and
labelled with its actual author; media there is described, not fetched or
transcribed. The owner's quote of an unadmitted member remains owner trust;
that member's own addressed message only knocks.

Albums are decided as a whole by sender, chat and media-group id before any
download, so a caption addressing the bot does not lose the other photos.
Pending group albums are bounded to 128 and 32 parts each. A let-in member
keeps the same person guards in a group. Its unasked file reads can reach
every member through an explicit reply, including people never let in.

Full access applies only to the private delegate route. Non-owner group
turns stay restricted even for a privately full-granted person. Their
history matches both the sender and private/group/topic audience; stored
explicit replies without an audience are legacy private replies.

An owner group turn keeps the owner's normal context, cursor, settings and
permissions. Its normal agent token does not gain a group reply route.
A separate reply-only `blr_` token binds the verified owner id, bot,
generation, lane, turn, group, topic and addressing message. Claude and Codex
mount the native `reply_to_sender` tool, and a tool-capable API engine uses
the same bound function. Codex keeps the owner's home and mounts only the
new reply server in approve mode through its per-turn overrides, with a
fresh 0700 socket folder removed on close. Other process engines can use the
targetless `bloks reply` command with the separate reply credential. An
engine with neither tools nor a process holds visibly in the app. A bound
callback does not make an active owner turn a person turn. Current terminal
sealing and owned-process cleanup still refuse new asks, replies or other
turn effects after completion.

Only an explicit reply reaches a group; chat text, cards, progress and files
do not. Every group member sees it. The owner's context and permissions may
therefore inform what it sends. The outgoing `reply_parameters` has only
the anchor's `message_id`; `message_thread_id` carries its topic. A deleted
anchor fails visibly, without retrying as a plain group post or a DM.

[Telegram privacy mode](https://core.telegram.org/bots/features#privacy-mode)
does not deliver mentions: it delivers commands meant for the bot, general
commands when it was the last bot to post, inline messages through it and
replies to messages meant for it. Privacy mode off, or admin status, is
needed for mentions; Telegram then supplies every group message, which Bloks
drops when unaddressed.

A person turn uses the existing untrusted approval path, including on a
full-access agent, and runs only on Claude Code. Claude starts a fresh
default-permission session, with empty setting sources and hooks disabled,
and checks the reported permissions and mounted tools before input, holding
on a mismatch. Every read and write of Bloks' own folder is refused to it
outright (`personClaudeDenials`): saved keys, every agent's bot token, the
agent's memory and the default working folder all live there. Codex holds a
person's turn, in the harness and again in its driver: its read-only
sandbox still reads every file the account can, and the reply sends without
a card. API engines hold it too, since they cannot wait on the owner's
approvals. A held turn says why in the owner's chat and tells the person
once, neutrally. Plain owner answers do not save session permissions.

A person's session is told as little of the owner as a stranger's mail:
no profile notes, no "About the person you work for", no agent memory and
no note tools. Its fresh session hears that person's own exchange only,
their messages and the replies sent to them, without the lane's summary or
the owner's side of the conversation; notes meant for the owner's next turn
(undone files, a stall, a failure, a backup's handover) wait for it. A
person's words keep their sender wherever they are retold: in the lane's
summary, in recall (`by: "telegram"`), and they are left out of skill review.

Claude person turns load the text of the working folder's `CLAUDE.md` and
`.claude/CLAUDE.md`, following symlinks, into the private system prompt each
turn. They are labelled as the owner's project instructions: "the user"
means the owner, not the Telegram sender. The combined text is limited to
100,000 bytes; an unreadable, non-file or oversized instruction file holds
the turn visibly. No global or local instruction files, settings, hooks,
permission rules, MCP configuration or `@` imports are loaded by this reader.

The native `reply_to_sender` tool takes one text field, with no target or
formatting controls. Its broker callback is bound to the sender, turn and
transport; its shell credential is reply-only too. Every other Bloks route
refuses it, including a say to another agent. Replies over 4096 UTF16 units
are refused, not truncated. The owner chat records sent, failed or uncertain
delivery. A turn cannot repeat the same attempted text automatically, and
its final chat text sends nothing without a tool call. The person's native
session never replaces the owner's cursor; the next owner turn starts from
the bounded conversation, including the person's exchange.

This tier permits reads inside the agent's working folder, outside Bloks'
own folder, and those reads can reach the person through the card-free
reply; a read elsewhere, a command or an edit asks the owner. Owner account
MCP servers are not inherited. An owner-approved shell that removes its
Authorization header can still use the existing loopback-owner API
fallback. The approval card names the person so the owner can decide.

A connection has a `generation`, renewed whenever its token, its switch
or its pairing changes. A poll, a card's buttons, the rest of a long
reply and a message waiting for a turn each carry the generation they
began under, and stop when it is no longer the agent's
(`currentTelegram`, `telegramConnectionCurrent`): a bot taken off an
agent, or another put on it, never finishes the old one's business.
Words that were waiting stay in the conversation as unsent, with a
notice. Putting a new token on the same bot keeps its owner and its
place in the queue of updates; a different bot starts with no one
paired. Deleting an agent removes its bot and token.

The workspace bot from before 2.8.0 moves to the agent it was set to
answer as (`migrateTelegram`), with its place and its paired chats, and
asks for the pairing word once more so it learns its owner's user id.
The people upgrade drops every old chat grant, retains the polling offset
and a verified owner, and persists one notice job for each previous chat.
The app also says the pairing word is needed again. A send interrupted by
a restart is uncertain and is never replayed automatically. When the agent
it named is gone, or already
has a bot, nothing is assigned by guesswork: the old bot waits, stopped,
for the person to choose an agent in Settings. A revoked pending bot can
also be removed there. Bot tokens are left out
of an unsealed backup like every other key (`SECRET_PATHS`), and a
restore without them keeps this computer's own.

A card a Telegram turn raises goes only to the verified owner's private
chat (`ownerChatId`, `telegramCards`, `server/telegram-cards.ts`), including
a card raised by an admitted person, except that a turn a person with full
access asked for asks them in their own chat instead. That person's next message never
answers it. For their questions, ordinary owner messages remain the owner's
messages: a typed answer must reply to that physical card, or the owner can
answer in the app. Such a card waits in a slot of its own (`personAsks`), so
it never takes the place of the owner's own waiting card. An approval comes with
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

While a Telegram turn runs the chat shows "typing" (`keepTyping`).
Completed visible notes from its consuming turn go out as new silent messages
in order, starting after twenty seconds (`telegram.Progress`, fed from stored
bot text through request-scoped `TurnProgress`). Notes in the first twenty
seconds or within the four-second throttle are batched; a batch over 4,000
UTF-16 units splits at whole-note boundaries. Only an individually oversized
note is cut with an ellipsis. The latest text stays pending until a following
tool or another visible text confirms it as a note, so a delayed turn-end
event cannot send the final-only reply as progress. Reasoning items and tool
names do not feed the messages; without a note there is nothing extra. Notes are never edited.
Cleanup cancels pending notes, awaits the post in flight, and deletes every
known message before the new notifying answer or notice. A failed deletion
does not prevent the answer. While a card waits on the person neither typing
nor notes post, since the agent is waiting then. An uncertain post suppresses
further notes in that turn because its message may have arrived without an id.
The tool line is deliberately removed. Normal answers take the last eligible
text after the request in its consuming turn, with waiting rows excluded;
completion captures that span before a later turn starts. The request keeps
its chat until that logical turn settles, with no deadline: a card answered
later on the phone, a retry, a handover to the backup or a fold of the
conversation keeps it waiting, and a later turn or another lane neither
delays nor supplies its answer. Files come from the same span. An end seen
while a steer is still being asked counts only when it was the turn the
words joined. A turn that ends without running (refused before its engine,
a pickup or a queued start that could not begin, an engine removed under
it, a fold that failed) answers with why. Retiring the connection or taking
the words back ends the wait. Drain returns keep
their existing `after` span and have no notes messages. With no reply, a plain
redacted notice is sent; only a turn with neither keeps the empty-answer line.

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
Rule suggestions (see Rule suggestions) are one of those counts.
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
speech (`CheckInHold` in `src/lib/notify.ts`), and an answer of QUIET
(trimmed, any case, with a full stop or exclamation) is written with
`quiet: true` at once. When the turn ends well with QUIET as its last
words, nothing but words, tool calls, a screen or a compaction marker
after the prompt, and none of the person's words joined it,
`foldQuietRun` marks the prompt and everything after it `quiet`: no
unread, nothing for a banner, a linked chat or the phone, the run is recorded
`quiet` in its history (an "ok" run with the flag) and left out of the
record, whose recent view a check-in every quarter of an hour would
flood. A check-in that fails, reports anything else, raises a card or
saves a file is shown like any turn, and its reply is said once when it
ends (`reply.settled`, see Desktop banners). The chat folds a run of quiet messages into one muted line ("3
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

A place watcher (`kind: "place"`) waits for the owner to arrive at a
place or leave it, by a name as the phone gives it ("Toronto", "Paris,
France": every part has to be one of the reading's names) or by
coordinates and a radius (100 m to 50 km, 500 unless said). It has no
schedule: it is asked as a reading arrives (`lookAtPlaces`), and on the
minute tick only while a crossing waits, so a reading that changes
nothing writes nothing. Its `seen` is the side it last saw and since when,
by the phone's clock (`placeStep` in `server/location.ts`). The first
side is a baseline, taken only from a reading under six hours old. A
crossing fires only if the reading is under thirty minutes old and the
side it left had held ten minutes, or was the baseline; one that does not
fire still moves the side, so a late or wobbling crossing is never acted
on afterwards. A point needs a reading with coordinates accurate enough
to tell (better than twice the radius, or a kilometre), and counts as
gone only past the radius and a margin of half of it (at least 150 m);
while readings carry no coordinates the watcher says so as its last
error. `once` finishes it after one turn and `until` at a time, both as
`done` with the watcher switched off; switching it on again clears that.
Sharing turned off, Forget, or the last phone unpaired clears every
place watcher's side. Only the owner's own agents may keep one, it speaks
only in the owner's own lanes, and it is not counted for a hosted
machine's next wake.

## Location

`server/location.ts`. The owner's iPhone says where it is, once the owner
turns Location on in the app there: `POST /api/location` with whether it
is sharing (`on`, `paused` or `off`), whether it shares with the app
closed, and when on, one reading: when the phone took it, the place in
words from the phone's own geocoder (city, region, country, time zone,
and the neighbourhood only with a full accuracy fix), and coordinates
with their accuracy only when the owner also turned on Exact position.
Only a paired owner device reaches the route: the guard names the
device, a member's device is answered by `serveMember` and never gets
there, an agent's credential is refused (`NEVER`), and a loopback window
has no phone to speak for. A hosted workspace refuses it
(`hostedRefusal`): a place goes only to a computer of the person's own.
Each field is checked; a reading from more than five minutes ahead of
this clock, or more than a week old, is refused, and a phone may report
120 times an hour.

The server keeps the newest reading and each phone's choice in
`location.json`, `0600`, never a history, and leaves it out of backups
and moves. An older reading than the one kept changes nothing. Off
forgets that phone's reading; paused keeps it for the owner's own
Settings but no agent hears it and no watcher acts on it. Revoking the
phone, or switching pairing off, forgets it all. `GET` and `DELETE` are
the owner's: the desktop's Location card under Phone and devices shows
the last place, its age, which phone and how exact, and Forget.

An owner's turn is told one line ahead of its text while sharing is on
and the reading is under six hours old: "Sam is in Queen West,
Toronto, Canada, approximately, as of 10 minutes ago, from their
iPhone." Only the owner's own turns in the owner's own lanes: never a
member's turn or solo agent, a Telegram person's, a stranger's mail, a
team lane, a member's lane or a shared room. `bloks location` (`GET
/api/agent/location`, under the same refusal) answers the reading with
its age in minutes, `current` up to fifteen minutes, `recent` up to six
hours and `old` after, how exact it is, and a note on what it is good
for. `--fresh` puts one private `location-request` frame with a one-time
id on the owner's own streams and, sealed, to owner devices through the
relay (as Device settings asks), and waits up to fifteen seconds for a
reading taken after the ask. A phone answers only while the app is open
and sharing; otherwise the answer says no reading came and why, and the
old one is never relabelled as new. Asks within ten seconds share one.
A report starts no turn and posts nothing; only a place watcher's
crossing does (see Watchers).

A phone gates all of it on `location` in `/api/health`.

## Standing intents

`server/intents.ts` is the third trigger beside routines (a time) and
watchers (something outside): words that come up in a conversation. An
intent is up to twelve phrases, where it listens (everywhere, meaning
every agent's own conversations and every room not shared with other
people, or named agents and rooms, a shared room only when named) and
one action: a note posted in that conversation in the person's words, an
agent brought in (woken in the room when it is a member, otherwise sent
the excerpt in its first conversation, and the conversation says so), or
a short message to an agent. Intents live in `intents.json`.

Every appended message is checked (`checkIntents`, from
`store.onAppend`): text only, not deleted or quiet, never a machine's
words (`via` other than a chat platform), a Telegram stranger, the
sender's copy of an agent message, a stranger's mail lane, a rehearsal or
a shared room's own lane. Matching is a pattern per phrase, any case, on
word boundaries, with a trailing `*` open; no model. A fire is recorded
before it acts, and the action runs after the message's own append has
gone out. The guardrails are on the intent: once per conversation per
cooldown (24 hours unless set, 1 to 168), three fires in any 24 hours,
and 90 days from making, approving or renewing, after which it reads
expired until renewed. It never hears its own output or another
intent's: its notes carry `intent`, its messages `via: "intent"`, a bot
reply in a lane whose turn an intent's message started is skipped
(`startedByIntent`), and so is what an agent it woke in a room says for
the length of a room turn (`intentWoken`). An intent that would bring
an agent in to its own words, or into its own conversation, does not.

The person makes, edits, pauses, renews and deletes intents in
Automations, Intents (`src/components/IntentsTab.tsx`), and the phone
through `GET`, `POST`, `PATCH` (`enabled`, `approve`, `renew`, any
field) and `DELETE /api/intents`. An agent's `POST` (`bloks intent`) is
always a proposal, listening only in its own conversations and rooms it
is in, at most five waiting; it does nothing until approved, the agent
sees and withdraws only its own proposals, and the brief counts them as
ready for a look.

## The nightly memory tidy

`server/memory-tidy.ts` tidies each agent's memory once a night, between
01:00 and 05:00 local, one agent per minute tick, skipping an agent that
is working (it is looked at again next tick), archived or without memory,
and anything while the shell has said the Mac sleeps (`macAsleep`) or
Bloks is draining. `memory.tidy` in config turns the night off; Tidy now
(`POST /api/bots/:id/memory/tidy`) works either way.

Lines ending `(until YYYY-MM-DD)`, which `memoryPrompt` teaches agents
to write for temporary facts, are removed the day after their date, in
MEMORY.md and topic files, with no model. Then, when MEMORY.md has at
least three notes and has moved since the last tidy, one one-shot call
(`generateText`, quick) on the agent's own engine, or the workspace's
drafting engine when that one cannot, answers with line edits only:
merge, reword (only if shorter), archive with a reason, and move to a
topic only near the budget. `parsePlan` checks every line it names; any
line not named stays byte for byte. Archived lines go to
`memory/archive.md` with the date and why. Nothing is written if the
agent started working or a file changed while the model thought.

Each file written is one journal entry by `"tidy"` carrying the run's id
(`MemoryEntry.tidy`), and `POST .../memory/tidy/:runId/undo` undoes the
night newest first, leaving any file changed since and saying so. The
run's diary (`diaryOf`) is written from what was done, not by the
model; the log keeps two weeks per agent (`memory-tidy.json`). The
Memory place shows the diary under the budget meter with Review and Undo,
and the morning brief carries one line per agent (`Brief.memory`),
never in its headline or spoken round.

A watcher that fails three looks in a row (the page will not load, the
feed is not one, the check broke) stops looking on its own, as a routine
that fails three runs does (see The incident desk). Holds are not looks
and never count.

## The incident desk

Failure used to leave a notice where it happened and nothing else, so a
person found out late or not at all. `server/incidents.ts` makes it a
thing somebody hears about. Each of these is an incident, with what
failed, where (agent, conversation, room, routine, watcher, workflow and
run ids), why (the failure's own words, redacted, one line) and when:

- a solo turn that failed for good: after recoverTurn's own retry and
  backup, never one that is asked again or handed on (`noteTurnEnd` in
  `server/index.ts`)
- a room turn that failed
- a turn that stopped on a silent tool call (`tool_stalled`)
- a routine's run, a watcher's look and a workflow's run that failed

Not incidents: a stop, a command, a conversation folded and asked again,
a rehearsal, a stranger's mail, a Telegram person's turn, a Fast Codex
refusal, and a routine's or a workflow's own turn, which its run speaks
for. `incidents.json` keeps the list, two hundred at most, the oldest
settled ones going first.

It goes to whoever leads (`chooseLead`): in a room, the room's lead
(`leadOf`); otherwise the agent named in Settings, or the one agent more
senior than every other (a tie at the top is nobody in particular). Never
the agent that failed, and never one that cannot act: listed, not
archived or held, on an engine whose turns get the command line. With no
such lead it goes straight to the person.

A lead gets one quiet turn: a note from Bloks (`via: "incident"`, the
note's `incident: { id, kind: "note" }`) queued into its first
conversation like any message, told what failed and the three things it
can do, and asked to answer QUIET, which folds the turn away as a
check-in's is. With `bloks incident retry|hand|tell <id>`:

- retry tries the failed thing once more: the turn asked again the same
  way (in memory, so not after a restart), the routine run now, the
  watcher looking, the workflow fired with the same trigger. A retry turn
  is not asked again or handed to a backup on top. One that works settles
  the incident; one that fails puts it to the person.
- hand sends a teammate what failed and what to do, as any agent's
  message (the chain limit applies), and settles the incident.
- tell puts it to the person with the lead's words.

A lead turn that chooses none, or fails, leaves it with the person, and
so does one that has not run within half an hour (`LEAD_WAIT_MS`).

The person's card is a notice in the conversation or room where it
happened, with `incident: { id, kind: "needs-you", state: "open" }` and
text that says it all, so a client that does not know the field still
reads it. It marks the lane unread, raises an urgent banner and wakes the
owner's phone like a blocked goal, and Activity and the brief list it.
Resolving patches the card to `state: "resolved"` with a `resolution`.

The storm rules are pure and tested in one place. The same thing failing
while its incident is open is counted on it (`count`), never a new one;
nothing about an incident, its lead's turn or its retry, ever raises
another. One automatic retry per thing (`subject`) a day and two per
conversation (`thread`) a day. Past five incidents in an hour the desk is
quiet: what fails is listed (`state: "muted"`) and handed to nobody, and
the person gets one card (`kind: "summary"`) that keeps the count.

`incidents` in `config.json` (`PUT /api/config`): `enabled` (on unless
off; off raises nothing) and `lead` (`"auto"`, `"person"` or an agent id).

Routines and watchers that keep failing stop. Three failed runs or looks
in a row (`FAILS_TO_PAUSE`) set `failing: { at, error }` and the schedule
stops (`isDue`, the watcher tick), while the routine stays on. A notice
with `failing: { kind, id, name }` says so once, with Fix it, Pause and
Remove on the desktop. A run or look that works clears `failures` and
`failing`; so does any PATCH, the person's or the agent's own.

### For a phone (feature `incidents`, `automation-failures`)

- `GET /api/incidents`: `{ incidents, summary, desk, failing }`, newest
  first. An incident is `{ id, kind (turn|stall|routine|watcher|workflow),
  subject, thread, title, why, at, lastAt, count, where: { botId,
  botName, laneId, roomId, routineId, watcherId, workflowId, runId },
  lead: { kind: "agent", id, name } | { kind: "person" }, state
  (with-lead|retrying|needs-you|muted|resolved), retriedAt, handedTo,
  needs, card: { threadId, messageId }, resolvedAt, resolution, open }`.
  `desk` is `{ enabled, lead }`; `failing` as in Activity.
- `GET /api/incidents/:id`: `{ incident }`.
- `POST /api/incidents/:id/resolve`: `{ incident }`, the person's alone.
- `POST /api/incidents/:id/retry`: `{ ok, note, incident }`. The
  person's retry is not held to the storm rules; a lead's is.
- `POST /api/incidents/:id/hand` `{ to, note }` and `/tell` `{ text }`
  (600 characters at most): the lead's, with its turn credential, only
  while the incident is `with-lead`.
- `GET /api/activity` adds `incidents` (open ones) and `failing`:
  `[{ kind: "routine" | "watcher", id, name, error, since, failures,
  botId?, targetId? }]`.
- `GET /api/routines` and `/api/watchers` carry `failures` and
  `failing`; a stopped routine's `nextRunAt` is null. Pause is
  `PATCH { enabled: false }`, Remove is `DELETE`, and any PATCH starts it
  again.
- A brief may carry `incidents: [{ id, title, why, state, threadId,
  needs? }]` and `failing: [{ kind, id, name, error, since }]`, and is not
  quiet when it does.
- The stream sends `{ kind: "incidents" }` when the list changes.

## Meeting notes

`electron/resources/speech-helper.swift --meeting [--system]` transcribes
the microphone and, through ScreenCaptureKit (weakly linked, macOS 13+),
the Mac's own sound, closing a recognition request at each pause so every
stretch of speech is a segment. The renderer posts segments to
`/api/meetings/:id/segments`; ending the meeting gives the chosen agent a
turn in its Meetings lane with `notesPrompt`, and `actionItems` reads
"- Owner: task" lines back out of the reply for one-press handoff.

## Terminals

`server/terminal.ts` keeps up to eight shells per agent, each in the
agent's folder, each with an id, a name ("Terminal 2" until renamed) and
its own scrollback, in the order they were opened. They outlive the panel
and are ended when the tab is closed, when the agent is archived, or
after eight hours with nobody watching. The pty comes from `expect`,
`python3` or `script`; a resize sets the pty's size from outside with
`stty -f` on its device, and falls back to typing `stty` into the shell
only where the device cannot be found.

The routes are local only. `/api/bots/:id/terminals` lists and opens;
`/terminals/:sid` reads, renames (PATCH) and closes (DELETE);
`/terminals/:sid/input`, `/restart`, `/clear` and `/busy` do what they say,
`busy` reading the pty's foreground process group so a tab can ask before
it ends a running program. `/terminals/stream` is one event stream for
every shell an agent has, frames tagged with the shell's id, so tabs never
cost a connection each. The older `/api/bots/:id/terminal` routes act on
the first shell.

In the app (`src/components/Terminal.tsx` and `src/components/terminal/`)
every tab keeps its xterm alive while hidden. The panel is drawn once into
a detached element that moves between slots on each side of the chat, a
full-window overlay, or, in the desktop app, a window of its own
(`?terminal=<agent>`, `electron/terminal-window.mjs`), so moving it never
rebuilds a screen. Where it sits and how it draws are kept in
localStorage (`src/lib/terminalLayout.ts`, `src/lib/terminalPrefs.ts`).

## Recall and notes about the person

`server/recall.ts` searches an agent's own lanes, the rooms it is in and
its memory files (MEMORY.md and `memory/*.md`, each cut into pieces under
their headings and named by file), words in any order, with the message
before each hit. From a lane of a shared room it reaches only that room,
and no memory; the lane that answers mail from anyone reaches nothing,
and no other lane reaches it. Agents reach it with the CLI's `recall` and
chat engines with the `search_history` tool.

Ranking is BM25 in plain TypeScript (`server/recall-index.ts`): a word
counts for more the rarer it is in this agent's own past (its lanes,
rooms and memory together are the corpus), saying it again counts for
less each time, and a long message does not win by length. A gentle
recency edge (at most 15%, halving every 30 days) and a bonus for words in
the order asked or within eight words of each other come on top. Words
are folded before they meet (plurals, -ing and -ed, a silent e), small
words are left out, and a file name or a hyphenated word is matched whole
and by its parts. An agent's own search wants most of the words, as
before, and a hit's text is cut around where they sit.

Each conversation has an index in memory, built the first time it is
searched and kept in step by two hooks on the store: `onAppend` adds a
message to an index already built, and `onRewrite` hears every patch, move
and dropped transcript. The same words at another time (a reaction, a
queued message going) keep the index, and an edit, a deletion or a closed
lane drops it to be built again. A memory file's index is rebuilt when its
size or time moves, and a link is never read through. `IndexCache` holds
them all to a budget of three million postings, a few bytes each: once a
search is done, the least recently searched go until what is left fits,
and are built again if asked for. A test indexes 30,000 messages and
answers in well under a second.

The person's own search, the command palette and the MCP server's
`search` (`GET /api/search`), reads the same indexes over every
conversation of every agent still in the list and every room, ranked the
same way and wanting most of the words, so the message that answers comes
before the one that happens to be newest. Nothing taken back, rewound or
still waiting is in an index. A query of nothing but small words ("to be
or not") has nothing to rank on and is matched as typed, newest first, as
it always was.

Recall also runs before the person's own turn in one of an agent's
conversations (`recallAhead` in `server/index.ts`): never in a room,
shared or not, nor for a stranger's mail, another agent, a routine, a
watcher, a native command, a rehearsal, or a turn going on with an earlier
one (a pickup, a backup engine, a retry). It searches the agent's other
conversations and its memory topic files with the person's words; not
MEMORY.md, which the standing prompt carries, and not the conversation it
is in. A hit has to share at least two of the words, hold at least 45% of
what makes them particular (their words, each weighted by how rare it is)
and score at least 4.5, which is about two telling words in a history of
a few hundred messages (a very short history scores nothing that high,
which is the point); a message of fewer than two words worth matching is
not looked up at all. Up to three excerpts of about 500 characters each, each with
where and when it was said and by whom, go ahead of the person's words in
the turn's text, in a block that says they were found by matching words
and may be ignored. Never in the system prompt, so a resumed Claude Code
session keeps reading its cache (see Compactions). Nothing the
conversation's last forty messages were already given, or already say, is
given again. The person's message keeps what was added as `recalled`
(where, when, who, the excerpt), which the chat shows as "Recalled 2
notes" under it (`src/components/RecalledNotes.tsx`), opening to each
excerpt with where and when it was said, and a link to the conversation
or room it came from; GET `/api/bots` leaves it out for an agent's credential,
since it came from the agent's other conversations. Words that waited for
a turn are looked up together and the last of them keeps the notes. An
engine that is told the transcript each turn hears the notes once, with
the message they came with, since the transcript replays what was said.
It is on unless turned off, for one agent (`recallBeforeTurn`, in its
settings under Memory) or for the workspace (`recall.beforeTurn`, Settings,
General).
`server/profile-notes.ts` holds suggested and kept notes about the
person; agents suggest with `note` or `note_about_person` (three a turn),
only kept notes reach the prompt, and never in a shared room.

## Bringing a setup over

`server/setup-import.ts` reads what a person already taught other agent
tools, from a short list of known places under their home: Claude Code
(`~/.claude/CLAUDE.md`, `~/.claude/skills/*/SKILL.md`, the top level
`mcpServers` of `~/.claude.json`, and the allow and deny rules in
`~/.claude/settings.json`), Codex (`~/.codex/AGENTS.md` and the
`[mcp_servers.*]` tables of `~/.codex/config.toml`, read by a small TOML
reader of its own), OpenClaw (`SOUL.md`, `IDENTITY.md`, `MEMORY.md`,
`memory/*.md`, `USER.md` and `skills/*/SKILL.md` in
`~/.openclaw/workspace`) and Hermes (`SOUL.md`, the memories folder and
skills a few folders down in `~/.hermes`, each looked for rather than
assumed). Nothing is searched for and nothing there is written.

No credential is read or copied. A file named like one (`auth.json`,
`.credentials.json`, `.env`, tokens, keys, keychains) is never opened,
and a link is followed only to see where it goes, so a `SKILL.md` that
points at a credentials file is named as left out. Every file is capped
by size. Text is scrubbed of anything key-shaped (provider key prefixes,
bearer tokens, `name = value` pairs whose value looks generated,
passwords in addresses, private key blocks) and the item says how many
were taken out. An MCP server's environment and header values are
dropped whole, never scrubbed: the names come across with empty values,
and the server waits for the person to fill them in under Apps and keys
(`PATCH /api/mcp-servers/:id`, names it already has only). A name with
no value is never handed to an engine. Names that change how programs
start (`PATH`, `NODE_OPTIONS` and the rest of `server/env-names.ts`) are
not carried.

`GET /api/setup-import` is the review: every item by source, with a
preview, where it would go and whether it was brought over before.
`POST` imports the items the window names, and only those. It reads the
files again and takes from the window only which items and where, so an
item whose digest no longer matches the review is refused. Instructions
become an agent's instructions (if they fit) or a block in its
`MEMORY.md`, written through the memory journal so the Memory place can
undo it; `memory/*.md` files become topic files. A new agent is made once
per source per import. Skills go to the library under a free id, never
over somebody's skill, and no agent has them until the person attaches
them. Servers go to the registry on no agent. Rules go through the
policy's own checks and wait for the person to tick them: a Bloks rule
looks at one thing, so a translation may be broader than the original
only when it denies, and an allow that would let agents do more is left
out with the reason. `USER.md` lines become suggestions in About you.
`setup-import.json` keeps each item's digest, destination and the exact
text it added, so importing again replaces that text in place, or says
nothing changed, rather than adding a second copy. Both routes answer
only Bloks on this computer, never an agent's credential, a paired phone
or a remote window. The first run offers the review as an optional step
when something new was found, and Settings has it as a page.

## Bringing past sessions over

`server/session-import.ts` is the sibling of bringing a setup over, for
conversations: Claude Code's transcripts under
`~/.claude/projects/<folder>/*.jsonl` and Codex's under
`~/.codex/sessions/**/rollout-*.jsonl`. Nothing in either is read until
the import screen asks (Settings, Past conversations, and an optional
step of the first run, offered when `GET /api/session-import/places`
says either folder is there, which it answers without listing them).
Files are only opened for reading; a link is never followed to one, a
helper's transcript (`agent-*.jsonl`) is part of a session rather than
one, and a file past 256 MB is named as left alone. Each line is read for
the few fields that matter and anything else, a line that is not JSON
included, is skipped and counted. Codex writes what the person typed
twice, as an event and as an item among the instructions it injects, so
the events are read and the items only for a file old enough to have
none; Claude Code's own lines (a slash command's echo, its caveat, a
reminder, a helper's sidechain, an API error it stands in for) are not
the person's or the model's words and stay out.

`GET /api/session-import` lists every session by its folder, newest
first, with a title (the first thing the person said), its dates, how
many messages and which engine, and whether it is a conversation here
already. Sessions Bloks ran itself are left out: every session id an
engine reports is noted in `engine-sessions.json`, the Claude Code
sessions whose costs were kept before that count too, as does every
lane's cursor, and a Codex session whose originator is Bloks' own client.
`POST /api/session-import/review` with `{ picks, to }` reads each picked
session whole and returns it exactly as it will land, with a digest, how
it will carry on, and what stays behind. `POST /api/session-import` with
the same shape and the digests imports, reading the files again and
refusing one whose digest moved. `to` is `{ botId }` or `{ hire: true }`,
which makes one agent per project folder through `server/scout.ts`
(the team's lead, named for the project, working in the folder, on the
engine most of its sessions ran on). All three answer only Bloks on this
computer, never an agent's credential, a paired phone or a remote window.

Each session becomes a lane (`Store.importLane`, its messages written in
one go): the person's and the engine's words as text messages and each
tool call as an activity row with one readable line, all at the times
they were said and marked `imported` with the engine, then one notice
saying where it came from and how it carries on. A lane keeps the latest
3,000 rows. Every line of every message goes through setup-import's
scrub and the person's own stored keys through the inspection redactor;
a line either finds anything in is left out whole, with a marker.
`TaskRecord.imported` keeps the engine, the session id, the file (as ~)
and whether it resumes; `clientBot` ships `imported: { engine, at,
resumes }` on the lane, never the path or the id.

A lane carries on the engine's own session when the agent's engine is
that engine, the folder is still there (pinned as the lane's `cwd`,
since Claude Code finds a session by it) and the agent is not on a cloud
computer: the session id is the lane's cursor, and its first turn is
sent with `forkFrom`, so Claude Code resumes it with `--fork-session`
(2.0 and later; an older or unknown CLI starts a new session told the
story instead) and Codex with `thread/fork` (one that cannot fork starts
a new thread with the handoff). The person's own file is never written,
and only a cursor that is still the imported id is ever forked; from the
first turn the fork is the cursor, and is noted as Bloks' own. That
first turn is told once that the conversation was brought over. Anywhere
else the lane has no cursor and an empty `lastInstanceId`, so its first
turn is a new session told the bounded story, opening with where the
conversation was had. Recall reaches imported lanes like any other; a
hit says the conversation was had in that engine before Bloks, and its
replies are said by the engine's name.

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

Transcript width is also a per-device reading choice, kept in `localStorage`.
`src/lib/transcriptWidth.ts` normalizes it to Narrow (760 px), Medium (800 px)
or Wide (960 px); the thin DOM adapter applies the cap before React renders.
The conversation, room lenses and composer share that cap, with a 760 px
fallback. Agent text can use the column while the person's bubble and screen
previews keep their existing percentage caps.

The sidebar's conversations view (`src/components/SidebarParts.tsx`) is a
per-device choice in `localStorage`. Settings is a page beside the
sidebar, like Automations, with its pages listed once in
`SETTINGS_PAGE_LIST` (`src/lib/settingsPages.ts`), in groups: Account,
Workspace (pages whose id starts `workspace:`, headed with which
workspace beside the word), Agents, Integrations, Connections, Data and
Bloks. Anything that links into Settings passes a `page`; an id that
moved is sent on by `SETTINGS_REDIRECTS` (`cloud` is `plan` now), so an
old link always lands somewhere real. The list's search and the command
palette read the same list, rows included, and every page is built from
the pieces in `src/components/SettingsLayout.tsx`. Escape is handled
once (`src/lib/useEscape.ts`): the most
recently opened surface that asked for it closes, and Radix menus and
dialogs keep their own.

### Settings inspection

`bloks settings` lists the available categories. `--category` reads one,
with `--id` for an opaque record reference and `--cursor` for its next
page. Its single `GET /api/agent/settings` returns safe saved values,
effective values or unresolved policies, and the existing owner control.
It uses already-loaded owner metadata, not a config reread, provider
health or authentication probe. Credentials, commands, connection URLs
and opaque maps are configured status only. Unknown fields stay excluded.
Owner writes and the agents' existing never list remain closed.

The route sits behind the server's ordinary guard, not a guard of its
own: an agent's credential works only on this machine and only because
the route is on its list, members and invite holders are sent to their
own surface first, and a network caller needs a paired owner device. On
this machine the guard takes a valid member credential as the owner at
the keyboard; these two routes take such a credential at its word and
refuse it. Room visibility applies before totals, references and
pagination.

Free text that is shown passes through a redactor built from
`SECRET_PATHS` in `server/backup.ts`, the list the backups strip, plus a
short list of things a backup keeps that can carry a key (connection
URLs, an MCP server's command, arguments and environment, chat pairing
codes). A key added to the backup list is redacted here the same day.

Pages have at most twenty rows and 32 KiB; permitted text has a 256
codepoint bound and oversized values are omitted whole. Continuations
are caller/category/selection bound within one server boot. Collections
are live: membership is checked again on each page, deletion removes a
record, and an insertion before the cursor may be missed. There is no
persistent inspection snapshot store.

### Device settings

Some settings live only on a device: a window's theme and layout, the
desktop's native state, a phone's own preferences and what its operating
system decided (notifications, camera, microphone). The server keeps what
those devices say in memory (`server/settings-devices.ts`), and it costs
nothing until someone asks.

Reading `device.browser`, `device.native` or `device.phone` sends one
private `settings-request` frame, with a one-time id, to the owner's own
event streams and, sealed, to owner devices through the relay. Not to
members, not into the replay ring, not mirrored to a chat, and without a
wake: a phone asleep is not woken to be asked. A burst of reads within
five seconds shares one ask. The read waits up to a second and a half for
answers, less when every owner stream has answered. A desktop window then
reads its mounted owners, the preferences it stored and the native bridge
(given half a second) and posts one `POST /api/settings/device-report`.
Nothing in a window listens, times or sends between asks: mounted
components register a reader once and keep it current through a ref.

A window's report counts only as the answer to a live ask. A loopback
caller is the owner to this server whether or not it is a window, so an
unasked window report is refused rather than trusted, and an answer more
than ten seconds late is no answer. A phone also reports on its own, when
its stream connects and when one of its settings changes, because a phone
in a pocket cannot answer and its last word, dated, is better than none.
Those reports need a paired owner device's identity, which only the guard
supplies: through the relay or a token on the network, never a body field.

Each report replaces that device's last one whole. The phone describes
its own settings: an id, a kind (preference, system, credential or
lifecycle), the value, the device's own default, the part of the app that
owns the effective value and where the person changes it. A credential
can only say whether it is configured; anything else in its place is
refused. Values are scalars, strings are bounded and redacted, and a
malformed field reads as unknown rather than vanishing.

Inspection dates every entry against the ask its read waited on:
`current` means heard since that ask, `last-reported` is an older report
shown with when it arrived. A window that did not answer is not listed.
An owner device with nothing on record is listed as `unavailable`, with
its app build and when it was last heard from, never with a server
default in place of its values. Storage is bounded to 32 entries and a
day of age, pruned whenever the store is touched rather than on a clock.
Revoking a device, or switching pairing off, forgets what it said.

A phone gates its reports on `device-settings` in `/api/health`
(`server/features.ts`), so an older Mac is never sent one. An older phone
ignores a frame it does not know and is listed as unavailable.

## Rule suggestions

When the owner keeps answering the same approval the same way, Bloks
offers to make it a rule (`server/rule-suggestions.ts`). Each answer the
owner gives to an approval card for the owner's own request (not a
shared room member's, an email's or a Telegram contact's, and not one a
rule or a mode answered) is noted with its tool and the one target it
named, in `~/.bloks/approval-habits.json` (a month, at most 2,000).
Five approvals of the same tool and target pattern within 14 days, and
no refusal of it in that window, make a suggestion. The pattern is the
narrowest thing the approvals share: the exact command, or the words a
family of plain commands starts with (`runs`), the folder the files were
directly in (`in-folder`), the site the pages were on (`on-site`), or the
tool alone. Commands that run whatever they are given (a shell, an
interpreter, curl and so on) are only ever offered word for word. Each
narrow operator reads its one field rather than comparing text (`runs`
refuses anything chained, piped, redirected or substituted), a rule can
be held to one tool (`Rule.tool`), and a build that does not know an
operator never lets it allow. It is offered for the agent that asked,
when that agent alone reached the count, and for every agent only when
more than one did. Nothing on the safety floor (`server/safety-floor.ts`:
deleting, money, credentials and the places they live, Bloks' own
folder) is offered, an allow rule that is narrow or tool-held never
covers anything on the floor later either, and nothing a rule already
decides (allowed, or refused) is offered. `GET /api/rules/suggestions`
lists them; `POST /api/rules/suggestions/:id/accept` with
`{ "scope": "agent" | "everyone" }` writes an ordinary rule through
`cleanRule`, recorded as `policy.changed`; `.../dismiss` keeps one quiet
for 30 days. The desktop shows the first for an agent in its composer's
tray and all of them above the rules in Settings, and the morning brief
counts them as ready for a look. None of these routes is reachable with
an agent's credential.

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

The agent's command line (`bin/bloks.mjs`) reaches the workspace over
this computer's own address, so it needs network access even though
nothing leaves the machine. Outside `full`, Codex runs commands in its
`workspace-write` sandbox, which has no network access unless Codex asks
for it and the person allows it, and a `bloks` command run inside it
cannot connect. The command line says so (`network access required`,
with the address and "run the same command again with network access
allowed") rather than `fetch failed`, and `bloks help` carries the same
note, so the agent asks for the access instead of reading it as Bloks
being down (GitHub 251). A workspace that is not running answers
`nothing is answering at <address>` instead.

## Reasoning effort

An agent's `effort` is `low`, `medium`, `high`, `xhigh` or `max` (Low,
Medium, High, Extra high and Max on screen), or unset for the engine's
own. Each driver lists the levels it passes on as
`capabilities.efforts`, and `GET /api/instances` reports them per engine
as `efforts`: Claude Code all five, as `--effort <level>` on every turn
(from 2.1.252, the oldest CLI checked; an older one is sent none);
Codex all five as `turn/start.effort`, narrowed per model by the
`supportedReasoningEfforts` in its own `model/list` (reported as each
model option's `efforts`); Grok CLI `low`, `medium` and `high`, as
`--reasoning-effort`. The other engines have no dial and are sent none.

A level being chosen (`PATCH /api/bots/:id`, `POST /api/bots`, which is
`bloks hire --effort <level>`, or New agents with a model picked) has to
be one the agent's engine and model take; anything else is refused with
the levels that engine has. A level already saved stays when the agent
moves to an engine without it, so moving back brings it back, and an
engine with no dial keeps whatever it is given. Dispatch sends the
nearest level the engine running the turn has, the lower of two equally
near, so a saved `max` on Grok CLI runs at `high`, and the pickers show
that level with a line saying why. `null` on a patch goes back to the
engine's own. An exported agent carries its level as it was.

## Security checkup

Settings has a Security checkup page (`src/components/SecurityCheckup.tsx`)
that lists everything letting an agent, a device or a stranger reach
further than the person may remember choosing, each as "ok", "worth a
look" or "risky", with one sentence on why it matters and the way to
narrow it. `securityReport` in `server/index.ts` gathers names and counts
from what is stored (never a key, a secret's value, a device token or a
webhook address), and `checkup` in `server/security.ts` decides what to
say: agents in full access (risky), pairing on and how many devices,
email open to anyone and which agents' engines would refuse unlisted
mail, shared rooms opening the owner's tools, agents with a browser or
the use of this machine, saved secrets by name, the modes of `~/.bloks`
and its key files (`config.json`, `webhooks.json`, `pair-links.json`,
`people.json`, `identities/`; anything but 0700 and 0600 is risky),
webhooks switched on, engines an agent uses that are signed out, and
automatic backups when the build has them. Engines are asked through
the half minute snapshot cache.

Most fixes are links to where the setting already lives. The page does
three things itself: it moves an agent from full access to Auto (the
ordinary `PATCH /api/bots/:id`, since narrowing never needs asking
twice), puts file modes back (`POST /api/security/permissions`, which
leaves a link inside the folder alone, since changing its mode changes
whatever it points at), and forgets a saved secret
(`DELETE /api/security/secrets/:name`). All three routes and
`GET /api/security` answer only this machine: never a phone, a paired
browser, a remote window or an agent's credential, and `/api/security`
is on the agents' never list too. When something is risky, Settings
wears a red dot in the sidebar and the page a count in its list
(`src/lib/securityCheckup.ts` holds the one shared report); worth a look
waits on the page.

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

## Usage and spending limits

Usage is counted from events the drivers already emit
(`server/usage.ts`): tokens from `thread.token-usage.updated`, cost from
`turn.completed`. It is kept in `usage.json` as daily buckets by agent,
engine and, for a member's turn, the person who started it, about a year
of them, a convenience rather than an accounting record. It never claims
to know what is left of a subscription or a key: nothing exposes that,
and inventing the denominator would be worse than leaving it out. What a
Claude or ChatGPT plan has left comes from the engine itself, as its last
turn said (`server/plan-usage.ts`), and Bloks AI's from its service, as
shares.

A cost is an engine's own price when it reports one (OpenRouter does, as
`usage.cost`). Most API engines report tokens and no price, so a turn that
comes back unpriced carries its model and tokens, cached input included,
and is priced from OpenRouter's public model list (`server/model-prices.ts`):
asked at most once a day while an engine on a key of the person's own is
set up, with no key and nothing about the person in the request, kept in
`model-prices.json` with its fetch time, and retried an hour after a
failure. Matching takes a model id as each provider writes it and only
ever matches an exact listed name once a date, a host's build tag or a
dashed version is accounted for; a model the list does not name gets no
estimate, because a wrong price is worse than none. The person's own
price per million input and output tokens for an engine
(`config.json`, `spendPrices`) comes ahead of the list. An estimate is
kept apart from a reported price (`estimated` on the bucket) and always
written as one, `~$4.20`. Bloks AI is never priced and never added to a
dollar total.

`GET /api/usage/report` is the Usage page's: one span (`range` of `7d`,
`30d`, `90d` or `month`), for one agent or one engine if asked, and the
span before under the same filters. The page keeps its choices on the
device.

A spending limit (`server/spend-limits.ts`) is the person's monthly line
on an engine that runs on a key of their own (`auth` of `key` or
`oauth`), in `config.json` as `spendLimits` by engine instance, counted
from reported prices and estimates for the calendar month, local time.
At the line Bloks starts no new turn on that engine, with words saying
so, or hands the turn to the agent's backup engine, until the line is
raised or the month turns; a turn already running finishes, since
stopping it would waste what it had spent. `GET /api/spend-limits` lists
them and `PUT /api/spend-limits/:instance` takes `usd`, `price` or both.
Neither is reachable with an agent's credential: a line an agent could
lift would be no line.

`GET /api/usage-notices?thread=` gives the composer, and a paired phone,
what is near or at a limit for what that conversation runs on, worst
first: a Claude Code or Codex plan window used up, past its warning or
going faster than it renews; Bloks AI's own notice from its balance; and
a spending limit near (80%), on pace to run out, or reached. Each says
"Approaching limit" or "Limit reached" and when it resets, and View usage
opens the Usage page on that conversation's agent, at Limits. Dismissing
one holds until it says something new.

## Your plan

Settings, Plan reads the membership on the licence this computer keeps
(`server/plan-account.ts`). `GET /api/plan` asks bloks.dev, with the
licence as the bearer, for the account and the offers on that plan;
`POST /api/plan/manage` asks for the billing link only when it is
pressed; `POST /api/plan/hosting/link` asks for a pairing link to the
hosted workspace on the licence, for the managed hosting that is coming
(see Hosted mode); and `DELETE /api/plan/licence` forgets the key here
and takes the workspace offline. These answer this computer's own window
only, never an agent or a paired device, since the answer is read with
the licence itself. The key never comes back to the page, only masked. What
the site sends is read as unknowns and checked one field at a time, with
strings bounded and stripped of control and direction characters, and a
price is shown as the site wrote it, never worked out here. The last good
answers are kept in `plan-cache.json` under a fingerprint of the key, so
a plan still shows, dated, when the site cannot be reached, and a fresh
look moves the members and room sharing gates with the plan it reports.
`BLOKS_SITE_URL` points it somewhere else for tests.

The desktop app opens an offer with the key in the fragment of a
bloks.dev link and nowhere else (`electron/plan-link.mjs`), copies the
key without the page ever holding it, and opens Settings on Plan for a
`bloks://plan` link. Without a key, the page says Bloks is free with the
person's own keys.

## Bloks AI

A monthly allowance on the person's Bloks licence, with top-ups, pays for
model use, so an agent can run with no sign-in and no API key
(`server/credits.ts`, `server/bloks-ai.ts`). It began as prepaid credits,
which is why the code, the config keys (`credits.*`) and the routes
(`/api/credits`) still say credits; nothing saved had to move. The
allowance lives on bloks.dev; this machine keeps a token. Activating
Cloud (`POST /api/relay/activate`) keeps the licence in `config.json`
beside the other keys and trades it for a token at `POST <base>/token`, with
the licence as the bearer. A 401 from the service trades it again, one
exchange at a time however many calls were refused together, and a
different licence forgets the old token. A host started with
`BLOKS_CREDITS_TOKEN` uses that token as given; it is read once and taken
out of the process environment, so no engine inherits it. `BLOKS_CREDITS_URL`
moves the whole service (tests, somebody running their own), and the
checkout page, which Top up opens, is `/credits` on the same site. A
workspace whose Cloud was activated before credits existed is asked for
the key once more (`POST /api/credits/connect`, this computer only).

The service picks the model for every call, so the app knows one model,
`bloks-ai`, named Bloks AI. The Bloks engine (instance and driver kind
`bloks`, displayed as Bloks AI) is the generic OpenAI-compatible driver
with `fixedModels`: its catalog is that one model whatever `/v1/models`
lists, every call asks for it whatever an agent saved (an old `bloks-auto`
or a model the service once listed), and a saved selection on it reads as
`bloks-ai` on the API. It asks for its credential on every call
(`CompatAccess`): a 401 is answered by one renewal and one more try, and a
402 ends the turn with the service's own words, marked `credits: "empty"`
on the `runtime.error`. It is offered while Cloud is active
(`creditsOffered`) or the host came with a token, and a turn on an agent
saved on it while it is not says Cloud is what it needs.

Bloks AI is the Bloks engine and nothing else. Claude Code always runs on
the person's own Claude plan or key: its driver is never handed a base URL
or a token (`turnEnvironment`). An agent an earlier version had running
Claude Code on Bloks AI (`engineAccess: "credits"` in `bots.json`) is
moved at start, before anything listens to new messages
(`claudeOffBloksAi`): its engine becomes the Bloks engine's one model, a
backup on Claude Code becomes the Bloks engine too (or goes, when the agent
is on it already), the access is dropped, and one notice in its
conversation says so. Everything else about the agent stays. It is never
moved onto the person's own Claude sign-in, even when there is one, and
since the access goes with the move, nothing matches on the next start.
An agent on any other engine is left as it is.

Every call says what work it is, in `x-bloks-work`, so the service can
choose: `automation` for a routine, a workflow step, the incident desk's
note to a lead, words a watcher, a standing intent, a webhook or a routine
left in the lane, a quiet compaction, and a one-shot that is Bloks' own
bookkeeping (a summary, the memory tidy, skill suggestions); `coding` for
an agent whose title, description or skills say engineering; `general`
otherwise, the new agent draft among them (`workTag`, `turnOrigin`). A
turn a shared room member started also carries `x-bloks-member`, a hash
of that person's id here (`memberTag`), never a name or an address; the
owner's turns, and anything the owner set up, carry none. The Bloks
engine sends both as headers (`SendTurnInput.tags`, only on an engine
with `CompatAccess`).

What ran underneath, and what it was worth, stays with the service. Every
event from the Bloks engine is passed through `scrubEvent` by the bus
before it is logged or heard: its model is `bloks-ai`, its cost null, its
raw frame left behind. Usage counts a Bloks AI turn under `bloks`, the
engine report records its model as `bloks-ai`, and a shared room's spend
cap does not book it (the service caps a team's members instead). Every
agent on Bloks AI has one more line in its system prompt (`IDENTITY_LINE`):
it runs on Bloks AI, and says so rather than guess when asked what powers
it.

A used-up allowance is workspace wide: the refusal stands (`refused` on
`GET /api/credits`, on `/api/config` and in a `credits` frame) until a read
finds something left or a run on Bloks AI answers, and the composer of
every agent on it says it with Top up, which opens the checkout page in
the browser. A turn on Bloks AI never rests its engine (`recoverTurn`):
topping up should be felt at once. The token and the licence are in
`SECRET_PATHS`, so backups strip them and `redactSecrets` scrubs them by
value.

What is left is read from `GET <base>/balance` as shares, never amounts
(`readAiBalance`): `plan`, `usedPercent`, `leftPercent`,
`monthlyLeftPercent`, `topUps` (months' worth still to spend), `renewsAt`,
`low` and, on a team plan, `members` (`member`, `usedPercent`,
`dailyCapPercent`). A field that is not a share is not read. Settings
shows a meter ("62% of this month left"), the top-ups and the renewal, and
on a team each member by name (looked up here from the tag, never sent)
with a daily cap the owner sets as a share of the monthly allowance,
posted to `POST <base>/settings` as `{ memberCaps }`. Whether the licence
is a team's comes from the balance when it says, else from
`GET /api/hosting/status` beside the service, else the Cloud plan.

Work nobody asked for this minute (the nightly memory tidy, skill
proposals, quiet compaction of idle conversations) uses Bloks AI only
when `credits.background` is on, which it is not unless the person turns
it on. Tidy now is asked for, so it may. The morning brief makes no model
call either way.

A hosted workspace (`BLOKS_HOSTED=1`) on a team licence with an agent on
somebody's personal Claude or ChatGPT sign-in (Claude Code on its own
login, or Codex) says so, plainly and dismissibly, in Settings (Engines,
and the Bloks AI card) and on that agent's engine choice; nothing is
refused for it. A hosted workspace reads its balance soon after it
starts, so it knows whether it is a team before anybody opens Settings.

For a phone: `GET /api/credits` (`offered`, `background`, `refused`,
`checkoutUrl`, `team`, `needsKey`, `connected`, `plan`, `usedPercent`,
`leftPercent`, `monthlyLeftPercent`, `topUps`, `renewsAt`, `low`,
`members` with each `name`, `teamSignInWarning`, `readAt`, `problem`;
the old `balance`, `currency`, `lowAt` and `autoReload` are gone),
`PATCH /api/credits` with `{ background }`, `{ memberCaps: { [member]:
percent or null } }` or both, `team` in the `credits` frame and on
`/api/config`. An agent no longer carries `engineAccess`, and
`PATCH /api/bots/:id` takes `"own"` (or null) as said and refuses
`"credits"` with a sentence the phone can show. Features `credits` and
`bloks-ai`.

When an API turns a Claude Code call away, the CLI says so as `API Error:`,
the status and the body, which an older CLI prints as the JSON it was
sent. A notice says the service's own sentence instead (`errorWords` in
`server/failover.ts`), wherever a failed turn is said: the error itself,
the try again and the backup taking over, and the end of the line. What
decides whether the engine is out still reads the whole text. A 403 that
Claude Code marks as a failed sign-in keeps its words too, rather than
"not signed in": the service turning the person away is not something
signing in again changes.

## Hosted mode

`BLOKS_HOSTED=1` says this workspace runs on a machine somebody runs for
the person (`server/hosted.ts`). This is the server's side of managed
hosting, a private machine that stays on, which is coming soon and not
yet offered. The machine is the agents' computer, so the computer
choices are this machine or off (`hosted.computers` on
`/api/config`), a box or a VM chosen on a Mac becomes this machine, and
the API refuses the cloud box and the Local VM routes with code `hosted`.
What needs the person's Mac says so: working the Mac itself (the Electron
computer-use daemon is never read), Mac voices, and starting meeting notes.
On a hosted workspace `GET /api/health` answers any request from a loopback
peer ahead of the other checks (a Telegram reply credential is still
refused first), whatever Host its proxy chose and whatever credential it
carries; on a Mac the old rule stands. Either way it says `hosted`.

`BLOKS_HOSTED_VNC` (a port, or an http address on loopback with an
optional path) is where the image serves noVNC. The server passes it
through under `/hosted/desktop/<ticket>/`, pages and the websocket alike,
so the desktop needs no port of its own. A ticket comes from
`POST /api/hosted/desktop` (never an agent's), opens requests for ten
minutes after its last use and twelve hours at most, and nothing of the
person's (their token, their cookies) is passed to the viewer.

## Moving a workspace

`server/workspace-move.ts` makes a move a backup of kind `move`: the whole
workspace with the computer it leaves taken out. Folders on that disk
(an agent's or a lane's working folder, a room's desk, a project's
folders), engine sessions only that computer's CLIs can resume (every
lane is told the conversation on its next turn, as after
`store.dropSession`), the Undo history, rehearsal copies, the Local VM's
files, turns in flight, pairing links and Live Activity tokens stay
behind, and so do `config.json`'s machine sections (port, engine
instances, relay space, paired devices, shortcuts, cloud box). Keys never
travel, sealed or not; the file's summary names the ones left behind
(`toEnter`). `POST /api/workspace/move` writes one (this computer only)
and `GET /api/workspace/move/:name` downloads it. `POST
/api/workspace/move/import`, with the file as the body (and a passphrase
in `x-bloks-passphrase` if it is sealed), takes one into a workspace with
nothing said in it, no rooms and no standing work, from this computer or
the owner's paired device, and restarts through the restore path; the
machine it lands on keeps its own machine sections and keys.
