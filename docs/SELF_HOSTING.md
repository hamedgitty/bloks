# Running Bloks on a server of your own

`bloks-server` is the same workspace the desktop app runs, without the
desktop: for a small rented server, a Mac mini in a cupboard or a Linux
box at home. It listens on loopback only, and everything reaches it
through Bloks Cloud, which it connects out to: the iPhone app, the
desktop app on your laptop, a browser at bloks.dev/web, and the people
you share rooms with. No port is opened.

This page is about a server you run and look after yourself. It covers
what kind of machine Bloks thinks it is on, the settings that change
that, and a systemd setup that keeps running after a reboot or a crash.

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
| `BLOKS_PORT` | The loopback port. Defaults to 8799. |
| `BLOKS_COMPUTER_NAME` | The name your devices show for this server. Defaults to its host name. |
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
sudo -u bloks BLOKS_DATA_DIR=/var/lib/bloks/.bloks node /opt/bloks-server/bin/bloks-server.mjs activate blok_live_...
sudo -u bloks BLOKS_DATA_DIR=/var/lib/bloks/.bloks node /opt/bloks-server/bin/bloks-server.mjs pair
```

Open the printed link on the device to pair. Engines (Claude Code,
Codex and the rest) are installed and signed in as the `bloks` account,
which the terminal from your own devices is the easiest way to do.

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
says Self-hosted; and updates and location come back. An agent whose
computer was "This machine" has no screen until you pick another, and
its shell, files and browser work as before.

`BLOKS_HOSTED=1` keeps its meaning for managed hosting machines, where
nothing changes.
