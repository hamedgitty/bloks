# Security

Bloks runs AI agents that can read your files, use your logged-in
accounts, and drive a computer. That makes a few things worth stating
plainly.

## Reporting a vulnerability

Open a private security advisory on the repository, or email the
maintainer. Please don't file a public issue for anything exploitable.

## The model

**Everything is local.** Agents, transcripts, configuration and skills
live in `~/.bloks` on your machine. Bloks has no backend of its own, and
nothing you write is uploaded anywhere by us.

Bloks itself makes two requests, both fetches, neither carrying any of
your data: a packaged build asks GitHub for the latest release on
launch, and browsing the skill catalog fetches
`https://bloks.dev/skills/index.json`, held for half an hour. Point that
second one elsewhere with `BLOKS_SKILLS_URL`. Everything else on the
wire is the provider CLIs (Claude Code, Codex) and whatever connectors
you configure, talking to their own services.

**The harness server is loopback-only and origin-checked.** It listens on
`127.0.0.1:8799`, but loopback alone is not a boundary. A browser will
happily send cross-origin requests to it from any page you visit, and a
CORS "simple" request skips preflight entirely. So every request is
checked: the `Origin` must be absent or loopback, and the `Host` must
name the loopback interface, which defeats DNS rebinding. See
`server/http-guard.ts`.

**Secrets sit in a plaintext file.** `~/.bloks/config.json` holds any API
keys you paste, written `0600` inside a `0700` directory. That keeps
other user accounts out, but it is not encrypted at rest. Moving these
into the macOS Keychain is the top open item.

**Approvals are the safety gate.** When a provider asks to do something
risky, Bloks surfaces an approval card and blocks until you answer.
Don't route around it. Engines reach Bloks over protocols that can carry
a permission request (Claude Code and Codex natively, Gemini CLI over
the Agent Client Protocol) precisely so this gate exists; a headless
"approve everything" mode is not used.

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

## Skills are executable trust

A skill is markdown that gets injected into an agent's system prompt on
every turn. That means installing one is closer to running a script than
to saving a note: a hostile skill can instruct an agent to exfiltrate
files, misuse a connected account, or quietly ignore your instructions.

Bloks therefore:

- shows the full body before anything is installed,
- never fetches and installs a skill on its own initiative,
- caps skill size, and confines skills to slugged filenames inside
  `~/.bloks/skills` so a crafted name cannot escape the directory.

**Only install skills from a source you'd trust with your accounts.**
The same caution applies to anything an agent reads and treats as
instructions: web pages, issue comments, and email are untrusted input,
not commands.

**The macOS builds are signed and notarized.** Everything on the
Releases page is built by CI from a tag. The macOS `.dmg` and `.zip` are
signed with a Developer ID certificate and notarized by Apple, so they
open without a Gatekeeper warning and can be revoked if a build is ever
found to be compromised.

The Windows and Linux builds carry no signature. SmartScreen warns on
first run, and Linux does not expect one. If that matters to you, build
from source. See [docs/RELEASING.md](docs/RELEASING.md).

## What is not yet done

- Secrets are not in the Keychain.
- There is no sandbox between an agent and the rest of your machine
  beyond what the provider CLI enforces.
