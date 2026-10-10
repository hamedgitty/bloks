<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/brand/bloks-wordmark-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="public/brand/bloks-wordmark-light.png">
    <img alt="Bloks" src="public/brand/bloks-wordmark-light.png" width="320">
  </picture>
</p>

<p align="center">
  A local-first desktop workspace for personal AI agents.<br>
  Your agents, your machine, your data.
</p>

<p align="center">
  <a href="https://bloks.dev"><img alt="Website: bloks.dev" src="https://img.shields.io/badge/website-bloks.dev-004aad"></a>
  <a href="LICENSE"><img alt="FSL-1.1-MIT licence" src="https://img.shields.io/badge/licence-FSL--1.1--MIT-3bc76b"></a>
  <a href="https://github.com/hamedgitty/bloks/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/hamedgitty/bloks/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="macOS" src="https://img.shields.io/badge/macOS-desktop-6b7280">
  <a href="https://apps.apple.com/app/bloks-ai-agents/id6804453451"><img alt="iPhone app on the App Store" src="https://img.shields.io/badge/iPhone-App_Store-6b7280"></a>
  <img alt="Node 22+" src="https://img.shields.io/badge/node-22%2B-6b7280">
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/hero-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/hero.png">
    <img alt="A Bloks room: four agents working a launch together, with the most senior one reviewing what came back" src="docs/screenshots/hero.png">
  </picture>
</p>

---

Bloks looks like a messaging app. Each agent is a contact you talk to,
each room is a group chat, and the whole thing runs on your machine. No
account, no backend, no sync.

Underneath, every agent is a real provider session. Agents stream their
replies, show you the tools they are running, and stop to ask before
doing anything that needs your say-so.

## 📣 New in 2.6

**Agents that keep going.** Type `/goal` and say what done looks like, and
the agent keeps working turn after turn until it is done, stuck, or out of
turns, without you typing "keep going". Add a check like `pnpm test` and it
only counts as done when the check passes. A chip above the composer shows
the turn it is on, with Pause and Clear.

**Check-ins that stay quiet.** A routine can run every 30 minutes or every
few hours, only within the hours and days you choose. When nothing needs
you, the agent answers quietly: no badge, no notification, and a run of
quiet check-ins folds into one line. Each run remembers what the last real
one reported.

**Memory that carries across conversations.** Before your turn, an agent
looks through its other conversations and its memory files for what is
relevant and brings up a few short notes. "Recalled 2 notes" under your
message shows exactly what it was given, and search across your
conversations is ranked the same way.

**Backups.** Your whole workspace is backed up every day. Back up any time,
seal a backup with a passphrase, check it, and restore it from Settings or
`bloks-server restore`. A restore takes a fresh backup first and never
deletes what it replaces, and keys only ever go into a sealed backup.

**Bring your setup.** Already using Claude Code, Codex, OpenClaw or Hermes?
Bring their instructions, skills and tool servers into Bloks, reviewing each
item first. Nothing leaves your Mac and no keys or passwords are copied.

**Telegram that feels native.** Approve or answer a card with a tap, get the
files a turn made sent back to the chat, and see what a long turn is
working on.

**A security checkup.** One page in Settings shows what can reach your keys,
your screen and your agents, with a fix for each, and a turn that keeps
making the same call is flagged so a stuck agent is easy to spot.

Plus dozens of reliability fixes, from Undo and rehearsals to the desktop
app restarting its own server if it ever stops. The full list is in the
[release notes](https://github.com/hamedgitty/bloks/releases).

## What makes it different

**Agents work together, with a chain of command.** Put several in a room
and they take turns rather than talking over each other. The most senior
one speaks last, reviews what came back, and makes the call when members
disagree. An agent's memory follows it between rooms and DMs, so you can
ask your Chief of Staff privately what it thought of the group's plan.

**Cheap hands, expensive judgement.** A lead that needs more people can
propose a team: who it wants, what each one owns, which skills to give
them. You approve or you don't. Hires run on the cheapest model the
provider offers and do the volume; the lead keeps its costlier model for
review. That is the whole economics of it, and it is the same reason a
company has juniors.

**Any engine.** Claude Code, Codex, Gemini CLI and Pi run as real agents that
use tools and touch files. Gemini, Grok, Kimi, Llama, DeepSeek, Mistral,
Groq, OpenRouter and Ollama connect as chat engines. A custom
OpenAI-compatible host takes a base URL and one or more keys. OpenRouter has a
proper browser sign-in; the rest take a key or ride along with a CLI you
already signed in to.

**Every conversation in view.** An agent keeps up to twenty
conversations, one topic each. Turn on **Show conversations** and they
are listed under their agent in the sidebar, each with its own unread
dot and whether it is working or waiting on you. Opening an agent goes
to the conversation that pinged you, and a row at the top of the
sidebar says when anything at all is waiting on you. With the list in
the sidebar the tabs above the chat step aside; right-click a
conversation to rename it, mark it unread, copy its ID or close it.
Close the last one and a fresh one takes its place until you start the
next.

<p align="center">
  <img alt="The sidebar with each agent's conversations listed under it, one of them unread" src="docs/screenshots/conversations.png" width="720">
</p>

**Settings you can find.** Settings is a page of its own, grouped by
you, your agents, what they connect to and what they leave behind, with
a search that goes straight to the page a word lives on. So does
Cmd+K: type "voice" or "telegram" and press Enter.

**Skills are files you can read.** A skill is markdown that gets folded
into an agent's prompt. Bloks ships a starter library and shows you the
full body of anything before it is installed, because a skill is closer
to a script than to a note. After a conversation that worked something
out, Bloks can read it back and offer the procedure as a skill, or a
small edit to one you have, shown as a diff that keeps the rest of the
skill word for word. Nothing is ever installed on its own. Type `/` in a message to pick one of the
agent's skills by name, including the ones installed for Claude Code.

**Rules you write in a sentence.** "Refuse when the command contains
`rm -rf`." Rules are decided before an agent acts, not after, and only
what they do not cover reaches you. A deny always beats an allow.

**As careful as you want.** Choose once, during setup or in Settings,
how much agents ask: **Ask first**, **Accept edits**, **Auto** (only
your rules refuse), or **Full access**, which takes the engines' own
guards off too, with no prompts and no sandbox. Every new agent starts
there, any agent can be set differently, and shared rooms always ask.

**Take the wheel.** Driving something yourself for a minute stops the
agent: no turns start, routines skip, the job board looks elsewhere, and
anything it was mid-way through is interrupted. Refused rather than
queued, because a queue would replay a plan made before you changed
things underneath it.

**Undo what an agent did.** Before every turn, Bloks photographs the
folder the agent works in, and after it, again. What changed shows up
under the reply as a card: each file, how many lines, and its diff. One
button puts the folder back as it was. Anything you or a later turn
changed since is left alone and named, never overwritten.

<p align="center">
  <img alt="A card under an agent's reply listing the three files it changed, with an Undo button" src="docs/screenshots/changes-card.png" width="520">
</p>

**Rehearse it first.** Press the flask beside the microphone and the
agent does the task on an instant copy of its folder instead of the folder
itself. What it would change comes back as the same card, with **Apply**
and **Discard**; applying writes each file into the real folder only if you
have not changed it since. Pick other agents in the same bar and each
rehearses the task on its own copy, so you can compare their attempts side
by side in the Rehearsals panel and keep the best one. A follow-up in a
rehearsal's lane keeps refining the same copy.

**Rewind to here.** Hover any message you sent and choose **Rewind to
here**. That message and everything after it are taken back, the files
the agent changed since then are put back (any you have edited since are
left alone and named), and the agent starts over having heard only what
is left. Your message comes back to the box, to send again or change
first. What was rewound folds into one line you can open.

**A backup engine.** Subscriptions and API keys run out: a usage limit
until three o'clock, a rate limit, no credit, an outage. Give an agent a
backup in its settings and a turn that hits one of those is picked up by
the backup, with the conversation so far, instead of failing. The engine
that ran out rests until it should be usable again, for every agent on
it, and each agent goes back to its own engine by itself after that.

**Work with more than one step.** A workflow is a trigger, some steps,
and somewhere a person says yes. Runs are state on disk rather than a
promise nobody can restart, so quitting the app does not lose one.

**Answers that are not paragraphs.** An agent can reply with a chart, a
table, a recommendation, a sequence, a quotation or a refusal. Every one
is validated before it reaches a screen, because what arrives is JSON a
model wrote.

**A record you can check.** Consequential actions land in an append-only
log, each entry hash-chained to the one before it and signed by the agent
it is about. There is a button that walks the chain and reports
tampering.

**Your phone can answer, and so can any browser.** The [iPhone app](https://apps.apple.com/app/bloks-ai-agents/id6804453451) reaches your own
Mac over a sealed relay: approvals, workflow gates, and a screen showing
what every agent is doing right now and what the day has cost. Pair it by
reading a six digit code off your Mac. Approval banners carry the real
request, decrypted on the phone, with Allow and Deny behind Face ID;
anything in the share sheet can be sent to an agent; and Siri, Shortcuts
or the Action Button can ask one without opening the app. With Bloks Cloud, the same app you
use on your Mac also opens at [bloks.dev/web](https://bloks.dev/web) on
any computer: Settings, Phone and devices, **Use in a browser** makes a one-time
link. Every request is sealed in the browser for your Mac alone, so the
site that serves the page never sees what it carries.

**Share a room with people.** Invite a partner or a client into a room.
They join from the iPhone app or a browser, talk to your agents with
you, and never touch your computer: you choose which of your tools the
room may use, who may approve what an agent asks, and a monthly spending
cap. Rooms can also be carried into a Slack or Discord channel, or a
WhatsApp group, where agents answer only when they are mentioned and
strangers knock before anyone listens.

**Memory you can read, and take back.** What each agent remembers is
plain Markdown in its own folder. The Memory panel shows every agent's
files for editing, and a journal of every change, whether the agent
made it or you did, each with its diff and an undo.

**Teams as files.** A team is one Markdown file: a heading per member,
their seniority and skills, and a brief. Export any room as one, import
one from a friend, or hire from the gallery at
[bloks.dev/teams](https://bloks.dev/teams/).

**A morning brief.** Each morning (08:00 unless you choose another time)
Bloks writes up what every agent did while you were away, what is
waiting on you, and what it cost. Every line links to where it came
from, approvals can be answered from it, and Play reads it as a round in
which each agent says its own part in its own voice. It is built from
what is already on disk, not by a model, so it is free and instant.

**Watchers.** Point an agent at a folder, a web page or a feed, and say
what to do when it changes: "when an invoice lands here, file it", "tell
me when this price drops". A folder is seen within seconds, pages and
feeds on a schedule. The first look is only a baseline, a watcher fires
at most six times an hour, and it can rehearse on a copy first. Or just
ask an agent to keep an eye on something; it files the watcher itself.

**Meeting notes.** Press the waveform beside an agent's name and it
listens on your Mac: your microphone and, when you allow it, the other
side of a Zoom or Meet call. Transcription is Apple's, on the device;
nothing joins the call and nothing is recorded. When you stop, the agent
writes a summary, the decisions and the action items, and an item that
belongs to one of your agents is handed to it with one press.

**Agents that remember, and learn about you.** An agent can search its
own past conversations when something may have come up before. It can
also suggest short notes about you (how you like answers, your timezone,
names you use); nothing is added until you keep it in Memory, About you,
and a kept note is shared by every agent from then on, never with people
you invite into a room.

**Email your agent.** With Bloks Cloud, each agent gets an address like
`scout.3f9a1c0b7d2e4f6a8b1c@agents.bloks.dev`. Forward it an invoice, a
newsletter or a thread and it gets to work; what it says back is emailed
as the reply, and it can only reply to someone who wrote to it.

**Engine scout.** Bloks learns which engine does your work well from
what you do with it: a change you undo, a conversation you rewind past,
a rehearsal you discard. Settings, Engines shows how often each one's
work is kept and what it costs, and when a lighter model has been doing
as well for an agent, it says so with a button to switch.

**Voices without a key.** On a Mac, agents can speak with the voices
macOS ships with, so read-aloud, calls and the brief work from the first
day. ElevenLabs and OpenAI voices are there when you add a key.

**From your other AI apps.** Bloks is an MCP server: Claude Desktop,
Claude Code or Cursor can ask your agents for work, read their
conversations and see what is waiting on you. It cannot answer
approvals, delete anything or change settings. Settings, Apps and keys shows what
to paste.

**Always on.** Agents run where Bloks runs, and a laptop sleeps. Bloks
keeps the Mac awake while an agent is mid-turn and picks a turn back up
after a sleep. For agents that never stop, `bloks-server` runs the whole
workspace on a machine that stays on (a Mac mini, a Linux box, a VPS),
and the desktop app, the phone and the browser all reach it the same way.

## Install

Download it from [bloks.dev](https://bloks.dev), or from the
[Releases](https://github.com/hamedgitty/bloks/releases) page. The iPhone
app is [on the App Store](https://apps.apple.com/app/bloks-ai-agents/id6804453451). macOS
builds are signed and notarized, so they open without a Gatekeeper
warning. Windows and Linux builds are unsigned, which on Windows means
SmartScreen warns on first run.

Or run it from source:

```sh
git clone https://github.com/hamedgitty/bloks.git
cd bloks
pnpm install

pnpm dev:server   # the harness, on 127.0.0.1:8799
pnpm dev          # the app, on 127.0.0.1:5199
```

Open `http://127.0.0.1:5199`. For the desktop shell, run `pnpm
dev:desktop` in a third terminal.

**Requirements:** Node 22+, pnpm, and at least one engine. macOS for the
desktop shell and computer use; the browser app runs anywhere Node does.

**Ports:** the app listens on 8799 on this machine. If something else has
it, the desktop app moves to 18799, 28799, or any free port, and remembers
the one that worked so a paired phone keeps finding it. To choose one
yourself, add `"port": 9123` to `~/.bloks/config.json`, or set
`BLOKS_PORT=9123` when starting `bloks-server` or the app from a terminal.
When no port works, the app says which ports it tried and what is holding
each.

## Getting an engine

You need one of these before an agent can reply. Any of them works.

The first-run check, and Settings, Engines, install Claude Code, Codex,
Pi, Antigravity and the Grok CLI with one button. They go into your own
`~/.local`, so no admin password and no npm permission errors, and an
engine that is installed but not signed in says so, with a button that
opens Terminal at its sign-in. An agent whose engine is not ready says
so above its composer before you send anything, with the same buttons and
a one-click switch to an engine that is. To do it by hand instead:

| Engine | How you connect | Runs tools |
| --- | --- | --- |
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash`, then `claude` | yes |
| Codex | `npm i -g --prefix ~/.local @openai/codex`, then `codex login` | yes |
| Gemini CLI | `npm i -g @google/gemini-cli`, then a Google sign-in or a Gemini key | yes |
| Pi | `npm i -g --ignore-scripts @earendil-works/pi-coding-agent && npm i -g pi-acp`, then `pi` (or `pi-acp --terminal-login`) | yes |
| OpenRouter | Sign in from Settings, in your browser | no |
| Gemini, Grok, Kimi, Llama, DeepSeek, Mistral, Groq | Paste a key in Settings | no |
| Custom (OpenAI-compatible) | Paste a base URL and key(s) in Settings | no |
| Ollama | Run it; Bloks finds it on this machine | no |

The engines marked "runs tools" can execute commands and read files. The
rest only produce text, which matters more than it sounds: an agent moved
onto a chat engine quietly loses half its job. Bloks badges the
difference everywhere it shows an engine.

One OpenRouter sign-in reaches most of the labs above through a single
account, which is the shortest path from a clean install to a working
agent.

<p align="center">
  <img alt="The engines list in Settings" src="docs/screenshots/engines.png" width="820">
</p>

## Pair your iPhone

The [iPhone app](https://apps.apple.com/app/bloks-ai-agents/id6804453451) is a window onto Bloks running on your computer:
the same agents, their chats, and approval cards you answer with a tap.
Nothing runs on the phone, so it is paired with the computer once. It
takes about a minute, with both on the same wifi. It works the same from a
Mac, a Windows PC or Linux; the iPhone app calls it "your Mac" either way.

### On your computer

**1. Open Settings at the bottom of the sidebar and choose Phone and devices.**

<img src="docs/screenshots/pairing/desktop-settings.png" alt="Bloks Settings open on the Phone and devices page" width="720">

**2. Switch on Phones and devices, then press Restart now.** Bloks only
starts listening on your network when it starts, so this is needed once. If
your computer asks whether Bloks may accept incoming connections, allow it.

<img src="docs/screenshots/pairing/desktop-switch-on.png" alt="Phones and devices switched on, with a Restart now button" width="528">

**3. When Bloks is back, press Pair a phone.**

<img src="docs/screenshots/pairing/desktop-pair-button.png" alt="The Pair a phone button" width="528">

**4. Bloks shows a QR code, a six digit code, and the address for the phone.**
The code lasts five minutes and works once. If it runs out, press Pair a
phone again.

<img src="docs/screenshots/pairing/desktop-code.png" alt="A pairing QR code, a six digit code and the address to enter on the phone" width="528">

### On your iPhone

**5. Install [Bloks from the App Store](https://apps.apple.com/app/bloks-ai-agents/id6804453451) and open it.** Until it is
paired it says so.

**6. The quick way:** point the Camera at the QR code on your computer and tap
the Bloks banner. Bloks opens and asks to pair; tap **Pair this device**.

**7. Or by hand:** tap the round button at the top right, then **Settings**,
then **Mac connection**. Enter the address and port your computer shows, type
the six digit code, and tap **Pair this device**. The **Scan the QR on your
Mac** row there scans from inside the app if the Camera route did not work.

<table>
  <tr>
    <td align="center"><img src="docs/screenshots/pairing/phone-not-paired.png" alt="Not paired yet" width="200"><br><sub>5. Not paired yet</sub></td>
    <td align="center"><img src="docs/screenshots/pairing/phone-scan-confirm.png" alt="Pair with your computer after scanning" width="200"><br><sub>6. After scanning the QR</sub></td>
    <td align="center"><img src="docs/screenshots/pairing/phone-menu.png" alt="The menu with Settings" width="200"><br><sub>7. The menu, top right</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/screenshots/pairing/phone-settings.png" alt="Settings with Mac connection" width="200"><br><sub>7. Settings, Mac connection</sub></td>
    <td align="center"><img src="docs/screenshots/pairing/phone-code.png" alt="Address, port and code entered" width="200"><br><sub>7. Address, port and code</sub></td>
    <td align="center"><img src="docs/screenshots/pairing/phone-connected.png" alt="Connected" width="200"><br><sub>8. Connected</sub></td>
  </tr>
</table>

**8. That is it.** Settings says Connected, your agents are on the phone, and
the computer lists the phone under Paired, where the bin icon unpairs it.

<p>
  <img src="docs/screenshots/pairing/phone-agents.png" alt="The agents on the phone" width="200">
  &nbsp;
  <img src="docs/screenshots/pairing/desktop-paired.png" alt="The paired phone listed on the computer" width="480">
</p>

### If it does not connect

- **"Not paired with your Mac yet":** there is no pairing, or it was undone on
  the computer. Start a new code.
- **The code was refused:** codes last five minutes, work once, and a few wrong
  guesses close the window. Press Pair a phone for a new one.
- **The phone cannot reach the computer:** both need the same wifi, not a guest
  network, and no VPN on either side. Check you pressed Restart now.
- **Firewall:** if you declined the incoming connections prompt, allow Bloks in
  your firewall settings (on a Mac, System Settings, Network, Firewall).
- **It worked yesterday:** the computer's address can change when it rejoins
  the network. Enter the new one under Mac connection and tap Apply and
  reconnect.

## Where your data lives

Everything is under `~/.bloks`:

| Path | Contents |
| --- | --- |
| `bots.json` | Agents, their roles, models and resume cursors |
| `bloks.json` | Rooms and their members |
| `sidebar.json` | The order of the sidebar's sections |
| `messages-<id>.json` | One transcript per agent or room |
| `config.json` | Connected engines and keys, `0600` in a `0700` directory |
| `skills/` | Installed skills, one markdown file each |
| `checkpoints/` | Each turn's before and after, kept once per file version, for undo |
| `memory-journal/` | Every change to an agent's memory, with the text before and after |
| `rehearsals/` | The copies agents rehearse in, cleared when applied, discarded, or a week old |
| `events/`, `native/` | The canonical event stream, and raw provider traffic |

Bloks has no server of its own. It makes two requests on its own behalf,
neither carrying your data: a packaged build asks GitHub for the latest
release on launch, and browsing the skill catalog fetches it from
bloks.dev. Everything else on the wire is the engines and connectors you
configure, talking to their own services.

## How it is built

```
src/       React app: chat, rooms, panels, the pixel avatar system
server/    Harness: HTTP API, one SSE stream, provider registry, persistence
electron/  macOS shell: window, packaged server, speech and computer bridges
```

One rule holds the shape together: **the client holds no transports.**
The React app never talks to a provider. It sends typed commands over
HTTP and folds a single server-sent event stream. Every provider process
lives in the harness.

That is why adding an engine is usually data rather than code. An
OpenAI-compatible API is a spec in `server/providers.ts`. An agent CLI
that speaks the [Agent Client
Protocol](https://agentclientprotocol.com) is a spec in
`server/drivers/acp.ts`.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the longer version.

## Security

Agents can read your files, use your logged-in accounts, and drive a
computer. [SECURITY.md](SECURITY.md) states the trust model plainly,
including the parts that are not solved yet. The short version:

- The harness is loopback-only and checks `Origin` and `Host`, because
  loopback alone is not a boundary in a browser.
- Approval cards block until you answer, and engines are driven over
  protocols that can carry a permission request for exactly that reason.
- Keys sit in a `0600` file, not the Keychain. That is the top open item.
- There is no analytics token in this repository.
- Released builds are signed and notarized. One you build yourself is
  not, and macOS will tell you so.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Short form: one thing per pull
request, tell us what you verified rather than what you changed, and run
`pnpm typecheck && pnpm test && pnpm build` before you push.

Bloks is maintained by one person alongside other work. Issues and pull
requests are read, and answered when there is time. Small and focused
gets merged quickly; a branch that renames files, fixes a bug and adds a
feature may sit for a while.

```sh
pnpm test
```

Node's built-in runner, no framework to install. Around 850 tests
covering the origin check, input limits, model-output parsing, room
addressing, skill paths, workflow runs, the policy engine, the client
reducer, the colour palette's own contrast, and the real server over
HTTP. It takes about a minute and a half and needs no credentials. See
[test/README.md](test/README.md).

## Licence

[FSL-1.1-MIT](LICENSE). Free for any use except selling Bloks, or
something substantially like it, to other people. Internal use at work is
explicitly fine, at any company size, with no fee.

Every release converts to plain MIT two years after it ships, and that
conversion cannot be withdrawn.

[LICENSING.md](LICENSING.md) explains it in plain English.
