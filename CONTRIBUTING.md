# Contributing to Bloks

Thanks for being here. Bloks is a local-first desktop workspace for
personal AI agents, and it is small enough that one good pull request
moves it noticeably.

## Getting set up

```sh
pnpm install
pnpm dev:server   # the harness, on 127.0.0.1:8799
pnpm dev          # the app, on 127.0.0.1:5199
```

Open `http://127.0.0.1:5199`. For the desktop shell, `pnpm dev:desktop`
in a third terminal.

You need at least one engine to see an agent reply. The cheapest way in
is an API key in Settings; the fullest is a CLI agent like Claude Code,
Codex or Gemini CLI, because those can use tools.

Before you push:

```sh
pnpm typecheck
pnpm test
pnpm build
```

All three run in CI and all three must pass. The suite takes about four
seconds and needs no credentials, so there is no excuse not to run it.

## How the pieces fit

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first. The short
version, and the one rule worth internalising:

**The client holds no transports.** The React app never talks to a
provider. It sends typed commands over HTTP and folds one server-sent
event stream. Every provider process runs in the harness server. If you
find yourself reaching for `fetch` to a model API from `src/`, the change
belongs in `server/` instead.

Adding an engine is usually data, not code:

- An OpenAI-compatible API: add a spec to `server/providers.ts`.
- An agent CLI that speaks the Agent Client Protocol: add a spec to
  `ACP_SPECS` in `server/drivers/acp.ts`.
- Anything else: a new driver in `server/drivers/`, implementing the
  contract in `server/contracts.ts`.

## What we look for in a pull request

**One thing per pull request.** A focused diff gets reviewed the same
day. A branch that renames files, fixes a bug and adds a feature gets
read three times and merged never.

**Say what you verified, not just what you changed.** "Ran a turn through
it, tool call surfaced, approval card blocked until answered" is worth
more than any description of the code. If you could not verify something,
say that too. We would much rather know.

**Bring a test when there is one to bring.** Anything pure belongs in
`test/`, and anything touching the request path belongs in
`test/api.test.ts`, which boots the real server. See
[test/README.md](test/README.md) for how the suite is put together. Not
every change needs one; a bug fix almost always does, because the test is
the part that stops it coming back.

**Match the surrounding code.** The codebase has a consistent voice:
comments explain *why* a thing is the way it is, not what the next line
does. Naming is plain. There is no formatter to argue with, so read the
file you are editing and write like it.

**Prose style.** Copy that ships in the UI, in commit messages, and in
docs avoids em dashes and en dashes. Use a comma, a colon, parentheses,
or a second sentence. This is a house preference, applied consistently.

**Keep the approval gate.** Anything that lets an agent act without the
user seeing it needs a very good reason. If your change adds a way to
skip an approval, that belongs in its own pull request with its own
argument.

## Screenshots

The images in the README come from a seeded workspace, not from anyone's
real install, so they are reproducible and contain nobody's data:

```sh
node scripts/seed-demo.mjs /tmp/bloks-demo
HOME=/tmp/bloks-demo pnpm dev:server
pnpm dev
```

Edit `scripts/seed-demo.mjs` if a screenshot needs to show something new.
Nothing in it calls a model; the transcript is written by hand, because a
screenshot should not depend on what a provider felt like saying that day.

## Security

Do not open a public issue for anything exploitable. See
[SECURITY.md](SECURITY.md) for how to report it and for the trust model
you should assume while working on this.

Two things to keep in mind while writing code here:

- Anything a model produces is untrusted input, including text that ends
  up in the UI, in a file path, or in a shell argument.
- Every field that reaches disk or a system prompt needs a length cap.
  Add it to `server/limits.ts` rather than inline.

## Releases

You do not need this to contribute, but it is worth knowing how the thing
gets built. Pushing a tag makes CI sign and notarize a macOS build and
upload it as a draft release; [docs/RELEASING.md](docs/RELEASING.md) has
the details. `pnpm package` gives you the same build locally, unsigned.

## Commit messages

Write a subject line someone could scan in a changelog, then a body that
explains why. We are not strict about a format, but we are strict about
the body being useful. If a commit fixes a bug, say what the bug did.

## Reporting bugs

Use the issue templates. The single most useful thing you can include is
what you expected versus what happened, plus which engine the agent was
running on. Logs live in `~/.bloks` (`events/` for the canonical stream,
`native/` for raw provider traffic). Please scrub keys before pasting.

## Licence

Bloks is under [FSL-1.1-MIT](LICENSE), which behaves like MIT unless you
are selling a competing product, and converts to plain MIT two years
after each release. [LICENSING.md](LICENSING.md) explains it properly.

By contributing you agree that your contributions are licensed under the
same terms as the rest of the project, including the future MIT grant.
There is no contributor licence agreement to sign and no copyright
assignment.

Being straight about the commercial side, because you should hear it here
rather than work it out later. This desktop app is free and open, and
stays that way: not a trial, not a crippled tier, no seat count. A paid
hosted version is planned, agents that keep running when your laptop is
shut, and that is what would pay for the work. The FSL restriction exists
so that hosted version is ours to sell rather than anyone's, which is the
same reason the desktop app can stay free.

If that arrangement is not one you want to contribute to, that is a
perfectly reasonable position and better discovered now than after you
have written a patch.
