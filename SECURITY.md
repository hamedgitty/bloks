# Security

Bloks runs AI agents that can read your files, use your logged-in
accounts, and drive a computer. That makes a few things worth stating
plainly.

## Reporting a vulnerability

Open a private security advisory on the repository, or email the
maintainer. Please don't file a public issue for anything exploitable.

## The model

**Everything is local.** Agents, transcripts, configuration and skills
live on your machine, in the workspace's own folder: `~/.bloks` for
Personal, and a folder of its own in the app's data folder for every
other workspace. Bloks has no backend that holds your data, and nothing
you write is uploaded anywhere by us.

Bloks itself makes a few requests, none carrying your conversations: a
packaged build asks GitHub for the latest release on launch; npm is
asked whether an installed engine CLI has a newer release; browsing the
skill catalog fetches `https://bloks.dev/skills/index.json`, held for
half an hour (point it elsewhere with `BLOKS_SKILLS_URL`), and the team
gallery comes from bloks.dev the same way; the Catalogue of teams and
skills reads `catalog/index.json` from this repository's main branch on
GitHub (point it elsewhere in its settings, or with `BLOKS_CATALOG_URL`)
and the files it lists, kept on disk for offline, and a link you choose
to install from is fetched once, over https only; while an engine runs on a key
of your own, OpenRouter's public model list is fetched at most once a
day, with no key and nothing about you, to estimate what unpriced turns
cost; and with a Bloks key, bloks.dev is asked, with that key, about your
plan. Everything else on the wire is the engines (Claude Code, Codex and
the rest), the voice vendors whose keys you save (the text being read
aloud, to ElevenLabs, OpenAI, Fish Audio or xAI; and what you say on a
call or in meeting notes, as sound, a stretch at a time, to whichever
of ElevenLabs or OpenAI hears for you, unless a Whisper server of your
own or the Mac's on-device recognizer does), and whatever connectors
you configure, talking to their own services (with an app watcher on,
that includes a WebSocket to the realtime service Composio delivers
events through), and Bloks Cloud when you turn it on, which carries
sealed traffic it cannot read. A Chatterbox server for voices must be on
this computer or its local network (a loopback, private or link-local
address, or a local name): Bloks refuses an address on the internet,
since every reply read aloud is sent there as text with no key. A
Whisper server for hearing has the same rule, for the same reason: what
you say goes there as sound with no key. Recorded speech is held in
memory for the one request that turns it into text and is never written
to disk or logged; the page sends it to the workspace and never holds a
vendor key, and an agent's token cannot use that route. On a Mac
with phone access on, the desktop app
also says on the local network where each listening workspace is (see
Phones and other devices).

**The harness server is loopback-only and origin-checked.** Each
workspace runs its own, Personal on `127.0.0.1:8799` and the others on
ports of their own, and none listens on your network unless you turn on
phone access for that workspace. But loopback alone is not a boundary. A browser will
happily send cross-origin requests to it from any page you visit, and a
CORS "simple" request skips preflight entirely. So every request is
checked: the `Origin` must be absent or loopback, and the `Host` must
name the loopback interface, which defeats DNS rebinding. A request
that carries a proxy's forwarding header (`Forwarded`,
`X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP` and the like) is
never taken as local either, even from loopback: a reverse proxy or
tunnel on the same machine connects from there for somebody on the
internet, and NGINX by default rewrites `Host` to `127.0.0.1`. See
`server/http-guard.ts`. On a `bloks-server` that is still not enough:
a proxy that adds no forwarding header, or a plain TCP tunnel, can
deliver anybody to loopback with any `Host` and `Origin`. There the
owner's own commands also carry a key the server makes at each start,
in `local.key` in its data folder, readable only by the account it
runs as (`server/local-key.ts`), and a request without it is a device
like any other.

**A local service's wake is labelled, not trusted as you.** A program on
this computer can wake one agent in one exact private conversation
(`POST /api/bots/:id/wakes`, `server/service-wakes.ts`). Only a direct
loopback request with a loopback Host and no Origin or Authorization
header (and on a `bloks-server`, the owner's key above) is accepted, never a browser page, a phone, the relay or an
agent's credential: no more than any local program could already do
through the owner's API. Its words are kept as a local service's, which
nobody can edit, and the agent is told they are that service's request,
never your own words or your approval.

**Secrets sit in a plaintext file.** Each workspace's `config.json`
(`~/.bloks/config.json` for Personal) holds any API keys you paste,
and the header values you give a custom endpoint, which are handled as
keys: never sent back to a window, left out of backups and settings
inspections, and taken out of any error that quotes one. It is
written `0600` inside a `0700` directory. That keeps
other user accounts out, but it is not encrypted at rest. Moving these
into the macOS Keychain is the top open item.

**An engine's added accounts sign in on this computer, into folders of
their own.** A second Claude Code or Codex account is signed in with the
engine's own login, in Terminal, into a folder under the workspace's data
folder (`engine-accounts/`, `0700`). The engine writes its credential
there or in the macOS Keychain; Bloks never reads, copies, logs or sends
it, and only points a turn's CLI at the folder. Only the person's setup
(settings, instructions, skills, plugins) is linked in from the main
sign-in's folder, never its credential or its sessions. The folders are
left out of backups and workspace moves, and are never used for a turn
that works in a container or on another machine. Only a window on this
computer can add, sign in or remove an account; the owner's paired
devices can see them and choose the one in use; an agent's token and a
member get nothing. Removing one runs the engine's own sign-out, then
deletes the folder.

**Which program runs as an engine is the person's choice, on this
computer.** An engine's CLI can be started from a path other than PATH's
copy. Only a window on this computer can set it (never a phone, a remote
window or an agent's token), the path must be a file that can run, the
Cursor editor is refused where the Cursor CLI is meant, and every change
is written to the activity ledger.

**Bringing a setup over copies a key only when you tick it.** Bring
your setup reads Claude Code's, Codex's, Cursor's, OpenClaw's, Hermes'
and OpenBot's files under your home folder, read only, by name, and never
opens a file named like a credential (`auth.json`, `.credentials.json`,
`.env`, tokens, keys, OpenClaw's `credentials` folder). The one database
it opens is OpenBot's, read only, for one table of agent settings; its
chat history, vault and saved logins are never read. An OpenBot transfer
file you pick is sent to the workspace's computer and judged whole before
anything in it is read: a path that is absolute or climbs out, a link,
an encrypted entry or one past the size limits refuses the whole file,
which is then not kept. Files it brings into an agent's workspace are
regular files only, never over one already there, and never one named
like a credential. An MCP server's
environment and headers, and a chat app's token, arrive as names with
empty values. Each value is typed in by you, or copied from the other
tool's config because you ticked the box for that one value; a value is
never sent to the window, never put in the record of what was imported
or in what an undo keeps, and lands only where you would have typed it
(`config.json`). A chat app's token is checked with that app and saved
switched off. Rules an import makes are only ever as broad as the
original when they allow, and an agent's own tool limits become denies
for that agent alone. The routes answer only the owner, never an agent's
credential or a member, and every import can be undone.

**Approvals are the safety gate.** When a provider asks to do something
risky, Bloks surfaces an approval card and blocks until you answer.
Don't route around it. Engines reach Bloks over protocols that can carry
a permission request (Claude Code and Codex natively, Gemini CLI over
the Agent Client Protocol) precisely so this gate exists; a headless
"approve everything" mode is not used.
The one card an agent's credential may close is its own question asked
without waiting (Codex's async question), which nothing is held on:
`bloks unask` withdraws it, from that agent's own turn, with nothing
answered for you. Approvals, questions it waits on, workflow gates and
another agent's questions are refused, and an answer you gave first
stands.

**An agent's browser and computer go only where its settings and its
engine both allow.** Its own browser, with any sign-ins you borrowed into
it, and its computer reach an agent as tools on Claude Code, on Codex
and on the ACP agents that take MCP servers (Devin, OpenCode, Gemini CLI,
Cursor, Grok CLI, Command Code), only on a turn you asked for or set up,
never on an email from anyone or a shared room member's turn unless you
opened them to that room. Codex never has them on a turn that is not
yours, whatever the room allows. Claude Code and Codex call them without
asking on your own turns, as Claude Code always has; an ACP agent asks as
its own permission rules say, and its questions reach you as cards. The
cloud box's key travels to the computer server in its environment (for
Codex, in the thread's config over its standard input), never in a
command line, and is taken out of the copy of each turn's frames Bloks
keeps. An agent working in a container or over SSH reaches them through
the workplace gate with its turn's token; they run on this computer and
nothing of it is run there. An engine that cannot be handed them is
given neither and told so.

**Scripts are the owner, and ask like the owner.** `bloks-server run`,
`team apply` and `chat` ([docs/SCRIPTING.md](docs/SCRIPTING.md)) speak
as the person, so their routes (`/api/runs`, `/api/teams/apply`) answer
only this computer and the owner's own paired devices, never an agent's
credential or a member's device, and the commands refuse to run inside
an agent's turn. On another computer they take a paired device's token
from the environment or a file, never from the command line. None of
them answers an approval or a question on its own: a run that meets one
stops and says so, and the card waits in the app. Applying a team file
never deletes or archives anything and never touches an agent's engine,
keys or approvals.

**A turn's command line is narrower than you.** An agent's turn gets a
credential of its own that lasts the turn, works only on this computer,
and reaches only the routes listed in `server/agent-cli.ts`; each change
it makes counts against twelve a turn, and agents writing to agents are
held at the limit you set in Settings, Behaviour. Opening a new
conversation is on that list only as saying its first message, to the
agent itself or one it may already message, and is refused wherever that
message would be. An empty conversation, and which one you have open,
stay yours.

**An agent writes only into conversations it is part of.** An agent's
words arrive as a conversation's next turn and are answered with that
conversation's context, so knowing a conversation's id is not enough to
write there. An agent's credential may name one of the agent's own
conversations, the recipient's first one (where its words go without a
name anyway), one it opened with `bloks tab`, or one it is already in
exchange with, either way round; anything else is refused with that
rule before a word is written, the kept-back last message included. A
member's private conversation is never named by an agent, its own
included, and the routes an agent uses on its own conversations (a
component, a shared file, a new title) keep to the same rule. Without a
name, a reply goes back to the conversation it answers and a new request
to the first one; which conversation you have open never decides it.
Take-back and stopping another agent name no conversation at all, and
your own messages go wherever you send them, as before.

**An agent adds to your list, and only you close it.** A routine's report
that finds something you have to do yourself goes on your list
(`server/todos.ts`) through `bloks todo`, which is only on the agent's
own full credential: never a member's or a member's own agent's, never
a turn a Telegram person or an unlisted mail started, never a shared
room's. An agent reads, refreshes and clears only lines it put there,
by its own keys (`/api/bots/:me/todos`); the list as you see it and
marking a line done or dismissed are yours (`/api/todos` is on the
agents' never list, and a member's credential never reaches it). A line
is plain text, a title and a detail with lengths capped, shown with the
agent's name and a link to the conversation it came from; it runs
nothing and opens nothing but that conversation. What an agent read can
still steer what it writes there, as it can steer its answer, so treat
a line as the agent's words. The morning notification says only how
many things wait, never what they are.

**An agent can point at a setting, and propose a few, never change one.**
`bloks where` reads the app's own Settings index and `bloks open` puts a
button in the conversation that opens a page; neither changes anything.
`bloks settings propose` puts a card in front of you for one of a short
list of everyday preferences (`PROPOSABLE` in
`server/settings-proposals.ts`): Behaviour's recall, nightly tidy,
summarise as you go, other changed files and skill suggestions; the
morning brief's switch, time, notifications and sections; the proposing
agent's own notifications, effort and model on the engine it already
has; and the effort new agents start on. Nothing changes until you tap
Change, which only you can (`/api/settings-proposals` is on the agents'
never list, and a member's credential is refused), and the change is
the Settings page's own request, made as you and recorded as yours. An
agent never proposes approvals or rules, keys, secrets or sign-ins,
engines, members, invites or roles, phone access or pairing, remote
access or Bloks Cloud, the plan, billing or spending limits, the limit
on agents writing to agents or the task budget, backups or restore,
moving or exporting a workspace, deleting anything, the browser's sites,
Home Assistant, or anything about security: each is refused by name
with the page to send you to, and `test/agent-guide.test.ts` holds that.

**An agent cannot speed its watchers past the usual six turns an hour.** A watcher
is a way for an agent to wake itself, so each starts at most so many
turns an hour (`perHour`, `server/watchers.ts`). You set 1 to 30 on the
watcher's page. Through an agent's credential the limit is at most the
usual six (`agentPerHourCeiling`), so it can put back a limit it lowered
but never pass six; a higher limit you set stays until it lowers it, and
anything more is kept to that and the agent is told so. A finding
past the limit waits for the next turn allowed rather than being dropped.

**The renderer is pinned to its own origin.** The packaged app serves its
UI with a strict `Content-Security-Policy`: no remote script, no remote
frames, no form posts, and `connect-src 'self'`. The Electron window runs
with context isolation on and Node integration off, denies every
permission request except the two the app actually uses, refuses to
attach a `<webview>`, and hands any external link to your real browser
instead of navigating the app frame.

**Input is bounded.** Every field that reaches disk or a system prompt is
length-capped (`server/limits.ts`), oversized request bodies get the
socket closed rather than buffered, and an over-long message is refused
rather than silently truncated.

**Analytics are off unless you build them in, and blind when on.** There
is no analytics token in this repository. If you set `VITE_POSTHOG_TOKEN`
for your own build, autocapture, session recording and performance
capture are all disabled and text is masked, so only the named counters
in `src/lib/analytics.ts` are ever sent. No message content, agent name
or file path is included in any event.

**What a crash leaves stays here.** A native crash in any of Bloks'
processes leaves a minidump in this computer's crash folder, and the
crash reporter runs with uploading off, so there is nowhere it is sent.
macOS still writes its own report. The desktop app also keeps a small log
of its window and processes, `app.log` in its logs folder (on a Mac,
`~/Library/Logs/Bloks`), moved aside at 512 KB, never in a workspace's
folder and never sent off this computer. What the page writes to it is
budgeted, so a page failing in a loop cannot fill the disk.

**Signal is signal-cli's, not Bloks's.** An agent on Signal answers on
an account linked to signal-cli on this computer, which keeps the
account's keys in its own data folder; Bloks stores the account's number,
the owner's and who is let in, never a credential. signal-cli's daemon has
no password, so Bloks only ever talks to one on loopback, and anyone on
this computer who can reach that port can speak as the account: unlink it
in Signal on the phone (Settings, Linked devices) to end it. On the
owner's own account, signal-cli receives every conversation; Bloks reads
only Note to Self and drops the rest unread, but signal-cli may keep
attachments others send in its folder. A person let in without full
access talks to an agent with no tools and nothing of the owner's, and
everything their turn asks goes to the owner.

**The home asks first.** Home Assistant's token lives in `config.json`
with the other keys and never reaches a client or a turn. Agents see only
the entities the owner lists, and only agents the owner names, in the
owner's own conversations. Every change is a card unless the owner marked
that entity as one to change without asking, and locks, alarms and garage
doors always ask. A long-lived token acts as the Home Assistant user who
made it, so make it on an account that can reach only what agents should
be near. What devices report reaches an agent as data, cleaned and
bounded.

## Phones and other devices

Your phone, a browser at bloks.dev/web or another computer of yours
reaches a workspace as a paired device, with a bearer token of its own;
the workspace keeps only its sha256. Pairing is the only way to become
one, so it is kept narrow. A member's device comes in through an invite
instead (see People in your workspaces).

- **A code exists only when you ask for one.** Phone access is off until
  somebody turns it on at the computer, and the workspace listens on the
  network only after Bloks restarts with it on. It listens on IPv4 and
  IPv6, and takes IPv6 connections only from local addresses (unique
  local, such as Tailscale's, and link-local): a global IPv6 address,
  often the open internet with nothing in front of it, is refused. A six digit code and its
  QR are made when somebody presses Pair a phone, and the routes that
  make or cancel one answer only on this computer and on your own paired
  devices, which are the only way in to a workspace on a server with no
  screen; never a member's device or an agent's credential. A code works
  once, lasts five minutes, and five wrong tries close it. It is held in
  memory, never on disk, and the window closes it when the panel showing
  it closes. A pairing link, for a device on another network, works once
  for fifteen minutes and is shown only in those same places. Switching
  phone access off and removing every device answer only on the computer,
  since from a device they would cut that device off too. The one other
  way a pairing is made is for a phone you already paired, below.
- **A server reached your own way.** A `bloks-server` listens on
  loopback and is reached through Bloks Cloud unless its owner says
  otherwise where it runs (`server/self-host.ts`, docs/SELF_HOSTING.md):
  `BLOKS_LISTEN=0.0.0.0` to listen beyond loopback (in a container,
  behind its published port), `BLOKS_PUBLIC_URL` for the address of
  their reverse proxy, tunnel or VPN that devices pair at, and
  `BLOKS_CLOUD=off` to send nothing to Bloks Cloud or bloks.dev. None of
  them can be set from a device, and none widens what a request gets:
  anything that is not the server's own loopback needs a paired device's
  token, and without one reaches `/api/health` and the pairing claim
  alone. Its codes are the ones above, made only at the server or on a
  device of yours, and handed out with the address in a link that
  `bloks-server pair` prints at the server.
- **Finding the computer again.** On a Mac, while phone access is on and
  the workspace listens on the network, the desktop app announces it on
  the local network as `_bloks._tcp` (`server/announce.ts`): the
  computer's name, the workspace's name unless it is Personal, the port,
  and a tag that is a hash of a random key in the workspace's folder.
  Nothing in it is secret, and nothing in it is trusted. Before a paired
  phone sends its token to a Bloks it found that way, it asks
  `POST /api/pair/prove` with a nonce, and only a Bloks that holds that
  phone's pairing can answer with the right HMAC. The announcement ends
  with the server.
- **Another workspace from a paired phone.** A phone you paired with one
  workspace can ask it which other workspaces of yours are on the
  computer, and for a pairing to one (`server/other-workspaces.ts`). Only
  your own paired devices may ask: never a member's device, an agent's
  credential or the computer's own window. Only your own workspaces are
  listed, never one you joined, and a pairing is made only for one that
  is already online with Bloks Cloud or listening for phones, which only
  the computer can switch on. It is single use, lasts three minutes, and
  comes back over the channel the phone is already trusted on; a device
  may have five in ten minutes. The computer shows a notification each
  time one is made, whatever its notification settings, naming the phone
  and the workspace it asked from.
- **A terminal from a device.** A terminal is a shell with the account
  Bloks runs as, so on a computer running the desktop app it opens only
  in that computer's own window, never from a paired device. A machine
  nobody sits at is the exception, and only for its owner's own paired
  devices (`server/deployment.ts`): a managed hosting machine always,
  and a `bloks-server` of your own only when `BLOKS_OWNER_TERMINAL=1` is
  set where it runs, which no device can switch on. Never a member's
  device, a device nobody paired, or an agent's credential. A refused
  device is told why. Through Bloks Cloud its live output is sealed for
  the one device that follows it.
- **Pictures of a screen.** While an agent works, its browser or cloud
  computer is pictured for the window and your phone, and a person can
  click, type, scroll and press keys in them from the chat or the phone;
  an agent's credential cannot. The Mac's own screen shows everything
  open on it, so it is held tighter. It is pictured only while an agent's
  turn is driving the Mac and your phone asks, at most about once a
  second, by the desktop app, which needs Screen Recording already
  granted and never asks macOS for it. That picture never goes on the
  event stream, is refused to an agent's credential, and is not a route a
  member's device can call. A member's stream carries no screenshots at
  all, and nothing on a phone can click on the Mac.

## The Bloks browser

Bloks has a browser beside the chat that agents drive and you watch
(`server/browser-core.mjs`, `server/app-browser.ts`). In the desktop app
it is the app's own (`electron/app-browser.mjs`); on a server with no app
behind it, the server keeps it, a headless Chrome
(`server/server-browser.ts`). It is signed in as you wherever you sign
in, which makes it worth guarding.

- **Its own session, nothing of the app's.** Each workspace browses in a
  persistent session partition of its own (`persist:bloks-browser-<id>`):
  its cookies and storage are never the app's, and never another
  workspace's. A tab is a sandboxed `WebContentsView` with no preload, so
  a page has no `window.bloks` and no bridge to anything. Every
  permission a page can ask for (camera, microphone, location,
  notifications, devices) is refused except fullscreen and writing to
  the clipboard. Deleting a workspace clears its browser's data, and
  Settings, Browser signs out of every site at once.
- **Only the web.** A tab never goes to a `file:`, `chrome:`, `devtools:`,
  `javascript:` or `data:` address, or anything else that is not http or
  https, and never to a Bloks server on this computer, on any port a
  workspace or the app's own page uses, under any spelling of loopback.
  This is checked on every navigation and redirect, including the ones a
  page starts, and a page's requests to those ports are cancelled before
  they leave.
- **Who drives it.** An agent reaches it only through its turn's own
  credential (`/api/agent/browser`), and only in a turn the owner
  started in the owner's own conversations: never a member's turn, a
  shared room's, an unlisted email's or a Telegram person's, because the
  browser is signed in as the owner. Its settings, its picture and the
  route another app uses (`/api/browser`) are never reachable with an
  agent's credential. Another AI app reaches it through the MCP server,
  from this computer only, and gets less than an agent: nothing it does
  can ask you, so whatever would ask is refused for it. A hosted
  workspace has no Bloks browser.
- **On a server of your own.** With no desktop app behind it
  (`bloks-server`, the Docker image), the server runs the browser
  itself: a headless Chrome in a profile of the workspace's own
  (`browser-session` in its data folder), behind the same rules, the
  same commands and the same guard on every navigation, redirect and
  popup (Chrome's Fetch domain; every page starts paused until its guard
  is on). You see it as pictures and use it with input events
  (`/api/browser/screen`, `/api/browser/input`, `/api/browser/do`), which
  are the owner's alone, from any of your paired devices or a web door
  session: never a member's device, a guest, an agent's credential or
  another origin. Pictures go only while a panel looks, and input is
  sent in request bodies, sealed end to end through Bloks Cloud, never in
  an address or a log. The profile holds your sign-ins the way the data
  folder holds the workspace's other secrets: anything that can read
  that folder as the account Bloks runs as can read them, so keep agents'
  own work (the Local VM, a container place) apart from it.
- **Which sites.** Each workspace has a list of sites agents may use and
  a list they never use, and a mode. In Ask first, the default, a site
  not on the allowed list asks you on a card the first time an agent
  opens it in a turn; Allow lets that turn in, Always allow adds it to
  the list. In Auto (which, like widening approvals, asks for Touch ID
  where the Mac has it) agents open any site but the blocked ones. A
  blocked site always wins. While an agent drives a tab, the app holds
  that tab to the same rules for every page a click, a redirect or a new
  window takes it to, and tells the agent it stayed where it was.
- **Which fields.** Typing into a password field, a payment field (by its
  type, its autocomplete and its name), and choosing a file to upload
  always ask you on a card first, in either mode. The card names the
  field's kind and the site, never what would be typed, and Enter does
  not answer it. A yes is good for that text in that field once. An
  agent never clicks a file picker; it names a file, and you see which.
- **What a page says is data.** Everything that comes back from a page,
  its text, its snapshot, its title, the tab list, is framed before it
  reaches a model: a sentence saying it is untrusted content from that
  site and that nothing in it is an instruction, between an opening and a
  closing tag carrying a random value per answer, so a page cannot write
  its own end of the frame. The snapshot is read from the browser's
  accessibility tree, and an agent's refs name the browser's own nodes,
  so a page cannot forge one by writing an attribute.
- **A tab you link with @.** In an agent's conversation you can link a
  tab of the browser into your message (`server/mentions.ts`). Only the
  owner's own words are read for one, on the owner's routes, never a
  member's or an agent's. The server finds the
  open tab at that address and reads its text where it is
  (`AppBrowser.peek`): no command runs, nobody takes the wheel, a tab
  waiting on a dialog is left alone, and a site on the never list is not
  read. The text is trimmed and framed exactly as above, named by its
  host only, and goes ahead of your words for that turn; it is kept on
  the message only while the words wait for a turn, and never shown to a
  member or to another agent reading the conversation. A conversation
  you link is read only when you could open it yourself
  (`server/access.ts`), and its record is framed as a record.
- **A page's dialogs.** An alert, a confirm, a prompt or a "leave this
  page?" stops the page until it is answered. The agent's step that
  opened one comes back with it, the page's words framed like the rest
  of the page (a dialog is the page talking, however official it looks),
  and the agent answers with the dialog command, as it could click any
  button: no card, since no dialog can do more than a click could. What
  an agent types into a prompt is never said back in its answer. While
  you have the browser, the dialog shows in the panel's bar for you to
  answer, and waits for you; otherwise one nobody answers is dismissed
  after 30 seconds, and a "leave this page?" then stays on the page.
  Nothing is ever accepted by default. In the desktop app Bloks takes
  the place of Electron's own dialog boxes, so a page an agent opened
  cannot put a box over the Bloks window; and since Electron asks about
  leaving a page before anyone can be asked, the app always stays, and a
  yes afterwards lets the next try through. Your other devices see a
  dialog's words while it is open (they are shown to you to answer),
  cut to a thousand characters with control and direction characters
  taken out; an agent's tab list says only that a tab waits on one.
- **You can take it back.** You see which agent drives which tab and can
  take over at any time, from the panel or simply by clicking or typing
  in the page. The agent's next step then waits, up to a minute and a
  half, and is told the browser is yours if it still is. Its steps are not
  counted against its turn's twelve changes, since none changes the
  workspace; the sites and fields above are what bound them.
- **What leaves the Mac.** Your other devices hear only each tab's
  address and title, who drives it, the words of a dialog it has open
  and the downloads' names, never what is on a page; a phone looking on gets a small picture of the tab on
  screen, at most every second and a half, and a member's device gets
  none of it. Downloads land in the workspace's own `browser-downloads`
  folder, with the site's name for the file cut down to a plain name.

## People in your workspaces

A workspace can take people, and everything they say runs on your
computer, with your engines and your keys. So the door and the rooms
behind it are built to be narrow.

- **Getting in takes more than the link.** An invite works once, for a
  day. Its code is never sent to a server (it sits after the `#` in the
  link), guesses are rate limited, and a join password, when you set
  one, is checked only on your computer and closes the invite after five
  wrong tries. With Approve each person on, which is the default, nobody
  is in until you and they have read the same four words. Those words are
  bound to their device and to your workspace's join key, so a relay that
  swapped the key to read the request would show different words on the
  two screens.
- **The request travels sealed.** Joining is sealed for your workspace's
  join key, so Bloks Cloud, which carries it, cannot read the name or the
  password in it. The joiner's device token never leaves their device;
  your computer keeps its sha256.
- **A member's device reaches a named list and nothing else.** Every
  route a member may call is listed in `server/member-access.ts`, and
  anything not listed is refused, so a new route is closed to members
  until somebody decides otherwise. They never reach your settings, your
  keys or your own conversations, and what crosses to them from the event
  stream is stripped of tool arguments, file paths, screenshots of your
  screen and the buttons on your approvals.
- **Their turns get none of your standing trust.** A turn a member
  starts never runs in Full access, gets none of your saved secrets, and
  reaches your apps, tool servers or computers only where you opened them
  to a room. Approvals in a team conversation or a room go to whoever
  started the work, to you and to your admins; in a member's own private
  conversation or solo agent, they answer their own.
- **Their spending is capped by you.** Per member: a monthly limit on
  what your API keys cost, a share of Bloks AI, how many solo agents they
  may make and which engines those use.
- **Their own agents are deleted, never read.** You and your admins see
  the agents members made for themselves by name and maker
  (`/api/workspace/member-agents`), and may delete one. Nothing of what
  was said to it crosses that route either way: deleting it deletes its
  conversations unread, and the record names who deleted it and whose
  it was.
- **Who changes an agent's settings.** You change any agent's; an admin
  any agent's but your own solo ones; a member only the agents they
  made, and even there cannot let one act without asking past accepting
  edits, give it a computer, or move it to an engine their limits leave
  out (`mayChangeSettings` and `settingHeld` in `server/access.ts`,
  served by `/api/workspace/agents/:id/settings` for you and
  `/api/member/agents/:id/settings` for people you let in). The route
  refuses whatever the screen shows held, with the same reason, and
  never an agent's credential or a guest. An agent's settings carry
  nothing of its conversations: opening a member's agent is not
  reading it.
- **Private means private.** A member's one to one with an agent is
  theirs. You can turn on reading members' private conversations for the
  workspace, and every member is told which way it is set. Past the
  transcript too: the agent keeps a memory of that member's own there and
  works in a folder of theirs, what it looks back on is only what that
  member could already read, and your own conversations, search and
  recall never reach a member's private words (only reading them, when
  you turn it on). On Claude Code a member's private turn may not read
  or change any agent's own folder or anybody else's, even with a yes.
- **Each member's apps and keys are theirs.** A member's own Composio
  key and keys are kept apart from yours and from each other's
  (`people/<id>/own.json`, 0600), are never shown back to anybody, and
  are used only by a turn that member asked for in their own private
  conversation or solo agent: never a team conversation, a room, your
  turns or another member's. Who asked is the turn's own record, never a
  name in the words. Removing a member removes them. In that turn a
  request for a key or an app asks the member, never you, so nothing
  lands in your keys or signs in under your account.
- **Your accounts and your self are yours.** A member's turn, and every
  turn of a member's own agent (even one you set going in a room you
  share), gets none of your apps, keys, profile or shared memory, and
  none of what the engine itself brings on your computer: on Claude Code
  the connectors of your claude.ai sign-in (Gmail, Calendar, Drive) are
  off, only the MCP servers Bloks names are loaded, and your CLAUDE.md
  and Claude's memory of you are not read; on Codex the MCP servers in
  your own Codex settings and the apps of your ChatGPT sign-in are
  switched off for that thread, and a Codex that will not take that does
  not answer anyone but you. The agent is told whose apps it has: the
  member's own in their private conversation or solo agent, and nobody's
  in a team conversation or a room, so it never says it is signed in to
  your mail. Other engines that run a program (Gemini CLI, Cursor,
  OpenCode and the rest) still load an MCP server set up in their own
  settings on your computer; keep anything signed in as you out of
  those, or limit which engines members may use. OpenCode can instead
  be given a setup of the workspace's own (**Own setup for this
  workspace** under it in Settings, Engines and keys), which leaves your
  own OpenCode settings, plugins and servers out of every turn there,
  yours included; the providers it starts with are the ones you had
  connected, copied once into the workspace's folder, which stays private
  to you and out of backups.
- **A room's Auto reads the room as data.** In a room set to Auto, a
  message that names nobody is shown to a small model, with the members'
  names, roles and briefs and the last few lines, so it can pick who
  answers. Anybody in the room, a guest from a chat channel included, may
  write words meant to steer it, so they go in as escaped JSON inside a
  block marked as data, and the answer must be one JSON object naming ids
  from the list it was given; anything else, or no answer in 2.5 seconds,
  and the lead answers. It can only pick agents the sender could have
  named in that room themselves (`mayAddressInRoom` in
  `server/access.ts`). By default it uses an engine the room's agents
  already run on, so the room's words reach no provider they were not
  already going to; a different one is your choice in Settings. Only you
  can set a room to Auto: an agent's credential may not, since each
  message then costs a call on your engine.

Who sees what is decided in one file, `server/access.ts`, as plain
functions a test can walk. Workspaces never share a folder, so an agent
in one cannot read another's memory, and the safety floor keeps agents
out of every workspace's folder, not only their own's.

## A server opened in a browser, with your identity provider

`bloks-server` can also answer browsers at an address of your own
(`BLOKS_WEB_URL`), signed in with an OpenID Connect provider you run or
use (`server/web-door.ts`, `server/oidc.ts`). It is off unless set, and
it is a listener of its own, so the loopback port keeps every rule
above.

- **Nothing through it is the computer itself.** A reverse proxy on the
  same machine connects from loopback with whatever Host it sends, so
  connections through the web door are marked, and `isLoopbackPeer`
  refuses them (`server/http-guard.ts`). An agent's credential, the
  loopback-only routes, pairing and the terminal are out of reach there.
- **One credential, one place.** A session cookie, HttpOnly,
  SameSite=Strict, Secure with the `__Host-` prefix on https, is the only
  thing the door reads; an Authorization header is dropped, so a paired
  device's token does nothing there and a session does nothing anywhere
  else. A request that changes anything must carry the door's own
  Origin. Only the cookie's sha256 is kept (`web-sign-in.json`, 0600).
- **The sign in is the standard one, checked fully.** The authorization
  code flow with PKCE (S256), a state that must come back once to the
  browser that started it, and a nonce. The ID token is believed only
  when its signature checks out against the provider's published keys
  (never the client secret, never `none`), and its issuer, audience,
  expiry, not-before, issued-at and nonce are right. The verifier and
  the client secret never reach the browser.
- **Who somebody is, checked on every request.** The owner is whoever
  `BLOKS_OIDC_OWNER` names, read again each time; a member is an
  identity linked to a person who is still in the workspace. Removing a
  member, or changing who the owner is, ends their sessions at once.
  The allow lists gate every sign in but the owner's, and making members
  on first sign in requires one, so a provider that knows everybody
  (Google) cannot make everybody a member.
- **An invite still needs you.** Signing in to use an invite makes the
  same request any device makes, bound to that browser's session, and
  it waits for you and the same four words. Until then the session
  reaches nothing but its own request.
- **Whoever controls the provider controls the door.** That is what
  single sign-on means: an account that can become yours at the
  provider, or join the allowed groups, can sign in. Use `sub` or a
  verified address as the person claim, not a name people can change.

## Agents that work somewhere else

An agent can work in a Docker container or on another machine over SSH
instead of on this computer. Its engine runs there; its stdio is carried
back over `docker exec -i` or `ssh -T`. The boundary between the two
sides is drawn on purpose:

- **Only the owner sets it, on this computer.** The routes refuse an
  agent's token, a member, a paired device and any website. Bloks only
  ever stops or removes a container it made for that agent, which it
  knows by a label it put there; a container you run is only execed into.
- **What crosses to the other side is the turn's own.** Its token, which
  lasts the turn; the agent's command line; the persona and the MCP
  config it would read here; the files the person attached to the
  message; and the secrets you saved for agents. All of it travels on the
  engine's own stdin, ahead of the engine, never in an argument that
  `ps` on either machine could read. This computer's environment does
  not go, and nor does any engine key or workspace key: Composio's, the
  box token, an `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.
- **Your engine sign-in stays here.** Bloks never copies a sign-in to a
  container or a host on its own. The Test says when the engine there is
  not signed in, and offers to open Terminal signed in there, or to copy
  your sign-in file after a card that names the file at both ends and
  says that anyone who can use that machine can then use it as you. The
  copy happens only for the plan that card showed, and is recorded with
  the agent. A Claude Code sign-in kept in the macOS Keychain is not a
  file, and is never copied.
- **The way back in is a gate, not the workspace.** On this computer a
  request with no credential is you, so the other side never reaches the
  workspace's own server. It reaches a gate (`server/workplace-gate.ts`)
  on a port of its own: over an SSH reverse tunnel bound to the far
  side's loopback, at Docker's host address, or with the container's
  network off over a line of Bloks' own through `docker exec`. The gate
  answers nothing but a running turn's token, passes the workspace only
  the headers the command line needs (no origin, no cookie, no relay
  mark), where the agent's usual rules apply, and closes when the turn
  ends. The tunnel's port on the far loopback can be reached by anyone
  on that machine, and they get nothing without the token.
- **MCP servers stay here.** The approval bridge, the computer, the
  browser and your own servers run on this computer as before, and the
  engine there reaches each over HTTP through the gate. A server's key is
  added here, so it never leaves either.
- **SSH is keys only.** Bloks runs ssh with `BatchMode=yes`: no password
  prompt, and a host key this computer does not know is a refusal to fix
  in Terminal, never a question answered for you. A host is a name from
  your SSH config or `user@host`, and nothing that begins with a dash,
  which ssh would read as an option.
- **Network off means two hosts.** A container made with its network off
  reaches only Bloks and its engine's own service (`LINE_HOSTS` in
  `server/workplace.ts`), on 443, through a proxy Bloks answers. An engine
  whose hosts depend on how it is set up cannot be run that way.
- **What it does there is not undoable from here** unless its folder is
  this computer's own, mounted into a container. The settings say so, and
  so is the agent told. What it saves to its outbox there is brought back
  as plain files under plain names, never a link.

## Skills are executable trust

A skill is markdown that gets injected into an agent's system prompt on
every turn. That means installing one is closer to running a script than
to saving a note: a hostile skill can instruct an agent to exfiltrate
files, misuse a connected account, or quietly ignore your instructions.

Bloks therefore:

- shows the full body before anything is installed,
- never fetches and installs a skill on its own initiative,
- caps skill size, and confines skills to slugged filenames inside
  `~/.bloks/skills` so a crafted name cannot escape the directory,
- never changes a skill on its own. When suggestions are on, a review of
  a finished conversation can suggest a new skill or a change to one,
  and an agent can ask for a change (`bloks skill revise`, or an MCP
  client's `propose_skill_revision`). Every one of those is staged with
  its reason and its diff, and only the person keeps it. A conversation
  can contain anything a web page, a file or an email put into it, and a
  skill is read into every future turn, so letting a review or an agent
  rewrite one unattended would give whoever wrote that page a lasting
  say in what your agents do. The review is told that what it reads is
  data, and what it writes has anything shaped like a key taken out,
  but the guarantee is the person's approval, not the prompt,
- keeps every version of a skill, with who made it and why, so a change
  that got through can be seen and put back. An agent's credential can
  read versions and ask for a change against the version it read; it
  cannot edit, restore, install, or keep a suggestion, and a change
  written against a version that has since moved on is refused rather
  than allowed to undo the newer one,
- lets an agent ask for a new skill (`bloks skill create`) only as a
  request: the whole skill, files included, waits on a card in the
  conversation that shows all of it, and nothing is in the library until
  the person presses Add, through a route an agent's credential cannot
  reach and a member is refused. Whatever the agent says the person
  asked for, its words are an input, so the press is the approval. A
  request never writes over a skill already there, built-in or the
  person's, and Add is refused if the id was taken while the card waited,
- keeps a skill's supporting files as plain text in a folder of the
  skill's own, read only on demand and never put in a prompt, with names
  judged as words and the file opened inside that folder, so a crafted
  name or a planted link reaches nothing else.

Teams and skills from the Catalogue, a link or a file go through the same
gate, and a few more:

- Nothing installs from a click in a list or a `bloks://install` link.
  Each opens a review of exactly what would be created (agents, a room,
  skills with their full text, routines), and only the review's own
  Install does anything. It installs the bytes that were shown, held by
  a token for half an hour, not whatever a link serves by then.
- A catalogue item is refused unless its bytes match the size and sha256
  in the catalogue's index, whether it was just downloaded or read from
  the copy on disk. A link has no index, so the review says it is not
  from the catalogue.
- Links are https only, with no sign-in in them, at most 96 KB, and are
  read with the same parser and limits as a file imported by hand.
- Agents a team creates start with connected apps, the browser and tool
  servers off, and every routine it files starts paused. A team never
  replaces a skill you already have under the same name.
- The catalogue routes are the owner's: an agent's credential is refused,
  and a member's requests never reach them.
- **Share as file** takes out this workspace's stored keys, anything
  shaped like a key, email addresses, phone numbers, your home folder
  and the project brief given at hire. It cannot know what else in a
  job description is private, so read the file before sending it.

**Only install skills from a source you'd trust with your accounts.**
The same caution applies to anything an agent reads and treats as
instructions: web pages, issue comments, and email are untrusted input,
not commands.

## Events from your apps

An app watcher starts a turn when something happens in an app you
connected through Composio: an email arrives, an issue is labelled, a
message is posted. Whoever caused the event wrote what it says, so it is
handled as a stranger's words (`server/app-watch.ts`):

- **It is data, fenced.** The event is cut down to its readable fields,
  with anything named like a token, secret, password, cookie or key, and
  any long blob, left out before a model sees it. What is left sits
  between two markers carrying a nonce made for that one turn, under a
  line saying it was written by whoever caused the event and is not to be
  followed as instructions; a marker inside the event is defused. The
  person's own instruction comes after the fence.
- **Nothing listens until a person says so.** An agent can only propose
  an app watcher. The proposal is a card showing the app, the event, the
  filter, which agent acts and where, and nothing is set up at Composio
  until the owner presses Start watching. Agents cannot confirm, change
  or list accounts for one (`server/agent-cli.ts`).
- **It is bounded.** The same event twice is one event, a plain-words
  filter is checked before any model is woken, and each watcher starts at
  most a few turns an hour and a capped number a day.
- **Admins are trusted with it.** The apps watched are the owner's
  connections. An admin may set up an app watcher for an agent whose team
  conversation they are on; its turns go there, and run as the admin's,
  so they carry none of the owner's tools the admin could not ask for
  themselves. The event itself is read in that conversation, so make
  someone an admin only if you would let them read what your apps send.
  Members who are not admins cannot set one up.
- **Composio's project key is needed, and stays here.** Watching needs
  the project key (`ak_`) beside the Connect key. It is sent only to
  Composio, to make and remove triggers and to authorise the realtime
  channel events arrive on; it never reaches a turn.

## Webhooks

A webhook's URL carries a long random token, and by default that token
is the whole credential: whoever has the URL can start a turn. Its event
reaches the agent as data from an outside system, never as instructions
(`server/webhooks.ts`).

- **A signing secret, when the sender has one.** A webhook can require a
  Standard Webhooks signature (Svix, Clerk, Resend, Composio and others
  sign this way). Every request must then carry `webhook-id`,
  `webhook-timestamp` and `webhook-signature` (or the `svix-` names), an
  HMAC-SHA256 of the id, the timestamp and the body exactly as it
  arrived, checked in constant time before the body is parsed. A
  timestamp more than five minutes off is refused, and so is a
  `webhook-id` the webhook accepted in the last ten minutes. A refused
  request gets a 401 with a short reason, reaches no agent, and leaves
  only a line in the webhook's recent deliveries, nothing of its body.
- **The secret is a saved key.** It is kept in `config.json` with the
  other keys, readable only by your account, because the check needs it
  whole. It is shown once, when Bloks generates it; a pasted one is
  never shown back, and no route returns either afterwards. It is left
  out of an unsealed backup and named in a move, and a signed webhook
  that arrives somewhere without its secret refuses every request until
  one is set again, rather than taking the URL alone.
- **Only you set it.** The webhook routes are the owner's. Members,
  admins and agents' credentials are refused, so no agent can set,
  remove or read a secret.
- **What it does not cover.** Seen ids are held in memory, so a restart
  forgets them; a captured request's timestamp keeps that to ten
  minutes at most, five either side of now. A webhook without a secret
  is exactly as before.

## Your runs, exported for training

Export for training (Settings, Data, and `bloks-server export-runs`)
writes every conversation it is pointed at into one file, which is the
point of it and also why it is held close (`server/run-export.ts`):

- **The owner's, on this computer.** The routes answer Bloks on this
  computer alone: never an agent's credential, never a member, never a
  paired phone or a remote window. The command refuses to run inside an
  agent's turn (a shell with `BLOKS_TOKEN` set). Nothing is sent
  anywhere; the file is written beside the data folder and shown,
  downloaded or deleted only by its own name.
- **Keys are always taken out.** Anything shaped like a key, token or
  password, and every value this workspace has saved as one, is removed
  before a result is shortened, so a key is never cut in two and left
  half recognisable. Email addresses, phone numbers, home folder paths
  and the names of the people the workspace knows (members, guests,
  people on Telegram and Signal, the owner) go too unless you keep them.
  The scrubber matches shapes and known values: a secret with neither,
  typed into a conversation in plain words, can survive it. Read the
  preview before you share a file.
- **Other people's words stay out.** A member's words, a Telegram
  stranger's, a person's on Signal, mail and chat apps, and members'
  private conversations are left out unless you turn them on, and turning
  either on asks first. Private conversations are not even counted unless
  reading them is on in Members.

**The macOS builds are signed and notarized.** Everything on the
Releases page is built by CI from a tag. The macOS `.dmg` and `.zip` are
signed with a Developer ID certificate and notarized by Apple, so they
open without a Gatekeeper warning and can be revoked if a build is ever
found to be compromised.

The Windows and Linux builds carry no signature. SmartScreen warns on
first run, and Linux does not expect one. If that matters to you, build
from source. See [docs/RELEASING.md](docs/RELEASING.md).

## What is not yet done

- The Bloks browser tells a payment field from its type, autocomplete and
  name, which a page can leave off. A card form drawn in a frame from
  another site, the usual way payment providers do it, never appears in
  an agent's snapshot at all, so you fill those yourself; a card field a
  page draws itself and names nothing is not caught. And a page can still
  show an agent anything: the frame says it is data, but a model can be
  talked into things.

- Secrets are not in the Keychain. The desktop app keeps your Bloks key
  there, but each workspace's API keys are still in its `config.json`.
- There is no sandbox between an agent and the rest of your machine
  beyond what the provider CLI enforces, unless you set it to work in a
  container (see Agents that work somewhere else). That includes agents
  a member of your workspace talks to: give a team agent only the folder
  and the tools you would let those people near. A member's turn on an
  engine with a shell (in their private conversation, a team
  conversation or their own agent) can, with their own yes, run a
  command that reads what your account can, the keys saved in your
  workspace's `config.json` and other members' files on this computer
  included, which the file rules do not stop. Bloks keeps your accounts
  out of what it hands their turns; it cannot keep a shell running as
  you from your files. Where members should be
  kept apart from each other as well as from you, give their agents an
  API engine or Bloks AI, whose only tools are Bloks' own, or a
  container. And whoever runs the computer can read everything kept on
  it; every member is told so when they join.
