# Running Bloks on a server of your own

`bloks-server` is the same workspace the desktop app runs, without the
desktop: for a small rented server, a Mac mini in a cupboard or a Linux
box at home. Your devices reach it one of two ways, or both:

- **Through Bloks Cloud.** It listens on loopback only and connects out
  to Bloks Cloud, which carries the iPhone app, the desktop app on your
  laptop, a browser at bloks.dev/web, and the people you share rooms
  with. No port is opened. Pairing is a link, from anywhere.
- **Your own way.** Behind your reverse proxy or tunnel at an https
  address of yours, or on your VPN or home network, with nothing of
  Bloks Cloud's in the path. `BLOKS_CLOUD=off` makes sure nothing goes
  there or to bloks.dev at all. See [Reached your own way](#reached-your-own-way).

With Docker, [DOCKER.md](DOCKER.md) takes you from nothing to a paired
server the second way with `docker compose up`.

This page is about a server you run and look after yourself. It covers
what kind of machine Bloks thinks it is on, the settings that change
that, how it is reached, and a systemd setup that keeps running after a
reboot or a crash.

## Three kinds of machine

Bloks asks four separate questions about the machine a workspace runs on
(`server/deployment.ts`), and Settings, About says the answers:

| Question | Desktop app | Self-hosted server | Managed hosting |
| --- | --- | --- | --- |
| Where it runs | inside the app on this computer | `bloks-server` on a machine of yours | a machine Bloks runs for you |
| Who looks after it | you | you | the provider |
| How Bloks there is updated | with the app | by you, from the app or on the server | with the machine's image |
| Owner's devices open its terminal | never | when you turn it on | always |

Settings shows a **Self-hosted** mark on a server you run and a
**Managed hosting** mark on a hosted machine. The desktop app reaching
either one is a window onto it: About says the app's version and the
server's apart, and which computer the server runs on.

## Settings, as environment variables

Set these where Bloks runs (the unit file below, a container's
environment, or the shell that starts it). None of them can be changed
from a paired device: a device that could open a shell for itself would
not need to be trusted with one.

| Variable | What it does |
| --- | --- |
| `BLOKS_OWNER_TERMINAL=1` | Your own paired devices (desktop app, iPhone, browser) may open terminals on this server. Off unless set. Never a member's device, a device nobody paired, or an agent. Has no effect in the desktop app, whose computer's shell is never reachable from a device. |
| `BLOKS_SERVER_UPDATES=off` | Settings, About and `bloks-server update` check for new versions but never install one. |
| `BLOKS_DATA_DIR` | Where the workspace lives. Defaults to `~/.bloks` of the account Bloks runs as. |
| `BLOKS_PORT` | The port. Defaults to 8799. |
| `BLOKS_COMPUTER_NAME` | The name your devices show for this server. Defaults to its host name. |
| `BLOKS_PUBLIC_URL` | Where your devices reach this server your own way: an https address behind your reverse proxy or tunnel, or an http one on your VPN or network, port and all. Commas for more than one. `bloks-server pair` hands a device this address. No path: Bloks is served from the root of it. |
| `BLOKS_LISTEN=0.0.0.0` | Listen on every interface rather than loopback (`::` for IPv6 as well). For a container, where the published port decides who reaches it; the image sets it. On a bare machine, a reverse proxy or `tailscale serve` reaches loopback without it. |
| `BLOKS_CLOUD=off` | Nothing goes to Bloks Cloud or bloks.dev: see [what that turns off](#what-needs-bloks-cloud). A licence already here is kept and not used. |
| `BLOKS_MODEL_URL` | An OpenAI-compatible model server's `/v1` root (vLLM, llama.cpp, LM Studio, LiteLLM, a self-hosted Qwen), listed as an engine. With `BLOKS_MODEL_KEY` (if it takes one), `BLOKS_MODEL_NAME` (what the app calls it), `BLOKS_MODEL_TOOLS=1` (its model calls tools) and `BLOKS_MODEL_VISION=1` (it sees pictures). Read each start, never written to `config.json`. |
| `BLOKS_HOSTED=1` | **Only for managed hosting.** Says a provider runs this machine for you. Do not set it on a server of your own (see below). |

## What stays with managed hosting, and why

Some behaviour depends on infrastructure a provider runs, not on the
machine being reached remotely. A server of your own does not get it,
and does not lose anything it needs because of it:

| Area | Self-hosted server | Managed hosting | Why |
| --- | --- | --- | --- |
| Terminal from your devices | with `BLOKS_OWNER_TERMINAL=1` | always | A shell is the most a device can be given, so on your own server you decide. |
| Updates | from the app, or `bloks-server update` | with the machine's image | The provider replaces the whole machine. |
| Location and place watchers | offered | not offered | Where you are goes only to a computer of your own, never to a machine run for you. |
| Agent computers | Cloud box, Local VM (needs Docker or Podman on the server), Off | This machine, Off | A hosted machine is the agents' computer already, with its own browser and virtual desktop. |
| Virtual desktop in the Computer panel | not offered | when the image serves one | It needs the hosting image's desktop and viewer. |
| Bloks browser in the app | not offered | not offered | It is a browser inside the desktop app, so only a workspace running in the app has one. An agent's own browser (Settings, Browser) works on any server. |
| Pairing link from bloks.dev | `bloks-server pair` on the server | asked of Bloks Cloud | Nobody can run `bloks-server pair` on a hosted machine. |
| Waking for routines | not needed | Bloks Cloud wakes the machine | Only a hosted machine is put to sleep. |
| Moving the workspace | backups, on the server | to and from your Mac, from the app | A move is the way into and out of managed hosting. |

Authorization is enforced on the server either way: a control the app
hides is also refused by the route, with the reason.

## Reached your own way

Set `BLOKS_PUBLIC_URL` to the address your devices use, put your reverse
proxy, tunnel or VPN in front, and restart. Ready snippets for Caddy,
NGINX, Cloudflare Tunnel and Tailscale are in [DOCKER.md](DOCKER.md#4-put-your-door-in-front-of-it);
without Docker, point them at `127.0.0.1:8799` on the same machine.

`bloks-server pair` then prints a link for each address, carrying the
address and a one time code that works once, for five minutes. The
desktop app takes it in Settings, Phone and devices, Your servers, and
from then on talks to the server at that address with a token of its
own, exactly as a phone on the same wifi talks to a Mac. The iPhone app
takes one for an `http://` address on your own network or your
Tailscale IPv6 address; it does not pair at an `https://` address of
yours yet. `bloks-server token --server URL --code 123456` gets a token
for the scripting commands on another machine.

What keeps strangers out does not move:

- Only a request that arrives on this machine's own loopback, with a
  loopback `Host` and no foreign `Origin`, is the person at the server.
  Everything else needs a paired device's token, and without one gets
  `/api/health` and the pairing claim, nothing more.
- A request that says a proxy forwarded it (`Forwarded`,
  `X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP` and the like) is
  never the person at the server, even when the proxy connects from
  loopback. That matters because NGINX, unless told otherwise, rewrites
  `Host` to `127.0.0.1`: every proxy above sends one of those headers,
  so its requests need a token like any other. Keep the proxy passing
  the original `Host` on all the same (Caddy and cloudflared do by
  default; NGINX needs `proxy_set_header Host $host`).
- A pairing code exists only once you ask for one at the server or on a
  device of yours, five wrong tries close it, and a device removed in
  Settings is cut off at once.
- Nothing about this can be set from a device: the address, listening
  beyond loopback and Bloks Cloud off are all where Bloks runs.

### What needs Bloks Cloud

With `BLOKS_CLOUD=off` nothing below is offered, and nothing is sent to
Bloks Cloud or bloks.dev. Everything else works as it does with it, and
the agents, which run on this server, never needed it:

| Needs Bloks Cloud or bloks.dev | Instead, your own way |
| --- | --- |
| Reaching the server from anywhere, and a pairing link from anywhere | Your address, through your proxy, tunnel or VPN |
| A browser at bloks.dev/web | The desktop app at your address |
| The iPhone app from anywhere, and what reaches a locked phone: notifications and Live Activities | The iPhone app while it is open, at an http address on your VPN or network |
| Email to agents, WhatsApp | Telegram, Slack, Discord and Signal, which each connect out on their own |
| People in your workspace (a Bloks Team plan, which bloks.dev checks), and the Plan page | Reaching your agents yourself, from each of your devices |
| Bloks AI | Your own models and keys |
| The skill catalog and team gallery on bloks.dev | The Catalogue, read from this repository on GitHub, or a mirror of the two lists named with `BLOKS_SKILLS_URL` and `BLOKS_TEAMS_URL` |

Update checks go to GitHub, not bloks.dev; `BLOKS_SERVER_UPDATES=off`
keeps them from installing anything.

### When Bloks Cloud cannot be reached

With Bloks Cloud on, it is a road between your devices and the server,
nothing more. If the relay cannot be reached, the line keeps trying in
the background, `bloks-server status` says it is not connected, and
agents, routines, watchers and everything reached your own way carry on.
A test holds this: a server whose relay is unreachable runs an agent's
task to the end, with Bloks Cloud on and with it off.

### Your own models

`BLOKS_MODEL_URL` lists an OpenAI-compatible server as an engine with no
Settings screen to visit, which is what a container wants:

```sh
BLOKS_MODEL_URL=http://127.0.0.1:8000/v1
BLOKS_MODEL_NAME=Qwen
BLOKS_MODEL_TOOLS=1
```

Its key, `BLOKS_MODEL_KEY`, stays in the environment and goes only to
that server; leave it empty for one that takes none. More servers, and
keys to rotate, are in Settings, Engines, Your endpoints. Ollama is found
on its own (`OLLAMA_HOST` when it is not on this machine). Claude Code
reads `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_MODEL`
from the environment Bloks runs in, for a gateway that speaks
Anthropic's API in front of your own model.

## A systemd service

Keep the release files owned by root, run Bloks as an account of its
own with no sudo, and let systemd start it at boot and again after a
crash.

```sh
# once, as root
useradd --system --create-home --home-dir /var/lib/bloks --shell /usr/sbin/nologin bloks
mkdir -p /opt/bloks-server
curl -LO https://github.com/hamedgitty/bloks/releases/download/vX.Y.Z/bloks-server-X.Y.Z.tar.gz
curl -LO https://github.com/hamedgitty/bloks/releases/download/vX.Y.Z/bloks-server-X.Y.Z.tar.gz.sha256
sha256sum -c bloks-server-X.Y.Z.tar.gz.sha256
tar -xzf bloks-server-X.Y.Z.tar.gz --strip-components=1 -C /opt/bloks-server
# the one folder the bloks account may write, for updates from the app
install -d -o bloks -g bloks -m 0755 /opt/bloks-server/versions
```

`/etc/systemd/system/bloks.service`:

```ini
[Unit]
Description=Bloks
After=network-online.target
Wants=network-online.target

[Service]
User=bloks
Group=bloks
Environment=BLOKS_DATA_DIR=/var/lib/bloks/.bloks
# your own paired devices may open terminals here
Environment=BLOKS_OWNER_TERMINAL=1
# reached your own way, behind a proxy on this machine, with nothing
# sent to Bloks Cloud (see Reached your own way)
#Environment=BLOKS_PUBLIC_URL=https://bloks.example.com
#Environment=BLOKS_CLOUD=off
ExecStart=/usr/bin/node /opt/bloks-server/bin/bloks-server.mjs
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
```

```sh
systemctl daemon-reload
systemctl enable --now bloks
# with Bloks Cloud; skip this one when it is reached your own way
sudo -u bloks BLOKS_DATA_DIR=/var/lib/bloks/.bloks node /opt/bloks-server/bin/bloks-server.mjs activate blok_live_...
sudo -u bloks BLOKS_DATA_DIR=/var/lib/bloks/.bloks node /opt/bloks-server/bin/bloks-server.mjs pair
```

Open the printed link on the device to pair. In the desktop app, paste
it in Settings, Phone and devices, Your servers (or Add a server in the
workspace switcher): each server you pair is a workspace of its own in
the switcher, beside the others, and you can turn off Run workspaces on
this computer to keep the app a window onto your servers alone. Engines (Claude Code,
Codex and the rest) are installed and signed in as the `bloks` account,
which the terminal from your own devices is the easiest way to do.

## Updates from the app

On the server above, Settings, About on any of your own devices (or
`bloks-server update` on the server) checks GitHub for a newer release,
shows its notes, and installs it when you press Install. No root, no
sudo and no shell on the server are needed for it:

1. The release's server tarball is downloaded into `versions/`, kept
   only if it matches the checksum the release publishes (and GitHub's
   own record of the file), and unpacked beside the version that runs.
2. Running replies finish first (the same drain as `bloks-server
   drain`); you can call the update off until then.
3. `versions/current` is pointed at the new version, a note of what it
   came from is left beside it, and Bloks stops with exit code 75.
4. systemd starts it again (`Restart=always`). The launcher in
   `/opt/bloks-server` hands over to the new version, which has two
   minutes to come up and stay up as itself.
5. The app reconnects and says the version now running. If the new
   version falls over while starting, or does not come up in time, the
   next start switches back and systemd runs the version before; the app
   says what happened, and `journalctl -u bloks` has the reason.

Your workspace, keys, settings and paired devices are in the data
folder, which an update never touches, and the environment in the unit
file (`BLOKS_OWNER_TERMINAL` included) is the same after it.

About says what is missing when the server can't update itself here:

- **The release in `/opt/bloks-server` is older than 3.2.0.** Update it
  by hand once (the steps About shows); from then on it updates from the
  app. The launcher there is the one that goes back if a new version
  does not start, so it has to know how.
- **The `bloks` account can't write `versions/`.** Run the `install -d`
  line above. With `ProtectSystem=strict`, add
  `ReadWritePaths=/opt/bloks-server/versions` and your data folder.
- **The unit doesn't restart it.** Set `Restart=always`.

`BLOKS_SERVER_UPDATES=off` keeps the checks and turns installing off.
Bloks only ever runs code from `versions/` when that folder belongs to
the account Bloks runs as or to root, and not every account may write
it (run as root, it has to be root's alone).

## Coming from `BLOKS_HOSTED=1`

Before 3.2, `BLOKS_HOSTED=1` was the only way to open a server's
terminal to its owner's devices, so some servers of people's own set it.
It also told Bloks a provider manages the machine, which hid update
checks, refused location, and swapped the Cloud box and Local VM for a
"This machine" choice.

On a server of your own, replace it:

```diff
-Environment=BLOKS_HOSTED=1
+Environment=BLOKS_OWNER_TERMINAL=1
```

and restart. Your workspace, keys, settings and paired devices stay as
they are; the terminal from your own devices keeps working; Settings
says Self-hosted; and updates and location come back. For updates from
the app under systemd, see the section above. An agent whose
computer was "This machine" has no screen until you pick another, and
its shell, files and browser work as before.

`BLOKS_HOSTED=1` keeps its meaning for managed hosting machines, where
nothing changes.
