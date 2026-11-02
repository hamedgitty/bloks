# Bloks with Docker Compose

From nothing to a Bloks server of your own, reached through your own
reverse proxy, tunnel or VPN, with your own models, and nothing sent to
Bloks Cloud or bloks.dev. About thirty minutes, most of it the proxy.

What you end up with:

- `bloks-server` in a container, as an account of its own (never root),
  restarted when it stops, with a health check.
- Everything it keeps in one volume: the workspace, the engines you
  install, and their sign-ins.
- Your desktop app and phone paired at an address of yours, talking to
  the server directly with a token each.
- Agents on your OpenAI-compatible model server (a self-hosted Qwen on
  vLLM, llama.cpp, LM Studio, LiteLLM, Ollama), on hosted keys, or on
  engines such as Claude Code and Codex.

[SELF_HOSTING.md](SELF_HOSTING.md) explains how the pieces fit, every
setting, and the same server without Docker.

## 1. Get the two files

Docker Compose 2.24 or newer. Either clone the repository:

```sh
git clone https://github.com/hamedgitty/bloks.git
cd bloks
```

or fetch just the two files into a folder of their own:

```sh
mkdir bloks && cd bloks
curl -fsSLO https://raw.githubusercontent.com/hamedgitty/bloks/main/compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/hamedgitty/bloks/main/.env.example
```

## 2. Fill in `.env`

```sh
cp .env.example .env   # if you cloned
```

The one setting you need is where your devices will reach the server:

```sh
BLOKS_PUBLIC_URL=https://bloks.example.com
```

That is the address of the reverse proxy or tunnel you set up in step 4,
or, on a VPN, the server's address there with the port:
`http://100.101.102.103:8799` for Tailscale, say. Give both, separated by
a comma, if you use both.

Everything else has a default. `BLOKS_CLOUD=off` is the default with
Compose, so nothing goes to Bloks Cloud or bloks.dev. The port is
published on the host's loopback, `127.0.0.1:8799`, for a proxy or tunnel
on the same machine; `BLOKS_BIND` changes that (step 4).

## 3. Start it

```sh
docker compose up -d
docker compose logs -f bloks
```

Compose pulls `ghcr.io/hamedgitty/bloks-server`. If it can't, it builds
the same image here from the release, checked against the sha256 the
release publishes. You should see:

```
bloks server on http://127.0.0.1:8799
[bloks] listening on 0.0.0.0:8799 for paired devices
[bloks] your devices pair at https://bloks.example.com
[bloks] Bloks Cloud is turned off here (BLOKS_CLOUD=off): nothing is sent to it
```

`docker compose ps` shows it healthy once it answers. Anything in `.env`
that could not be used is said there too, with why.

## 4. Put your door in front of it

Pick one. Each sends your devices to the container's port and passes the
original `Host` on. The server needs nothing else from the proxy: no
headers of its own, no paths, no auth in front (a device's token is the
auth). Two things matter for any proxy: Bloks is served from the root of
the address (not under `/bloks/`), and replies stream (live updates and
terminals are server-sent events), so response buffering is off and the
read timeout is long.

### Caddy

Caddy gets the certificate itself.

```caddy
bloks.example.com {
	reverse_proxy 127.0.0.1:8799 {
		flush_interval -1
	}
}
```

Caddy in a container of the same compose project reaches it as
`bloks:8799` instead.

### NGINX

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name bloks.example.com;
    ssl_certificate     /etc/letsencrypt/live/bloks.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bloks.example.com/privkey.pem;

    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:8799;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }
}
```

### Cloudflare Tunnel, with or without Access

No port is opened on your network at all. In the Cloudflare dashboard,
Zero Trust, Networks, Tunnels, make a tunnel and copy its token, then
add `cloudflared` beside Bloks in `compose.yml`:

```yaml
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN}
    depends_on:
      - bloks
```

put `CLOUDFLARE_TUNNEL_TOKEN=...` in `.env`, and give the tunnel a public
hostname, `bloks.example.com`, with the service `http://bloks:8799`.

Cloudflare Access with a sign-in page in front of this hostname stops the
apps, which cannot answer it. Leave Access off for it, or give it a
Bypass policy: the server's own check, a paired device's token on every
request, is what keeps strangers out. Access policies that need no page,
such as one that admits only your own IP ranges or a WARP-enrolled
device, work as they are.

### Tailscale

On the tailnet alone, with no public address at all: publish the port on
the machine's Tailscale address and nowhere else. `tailscale ip -6` says
it; the IPv6 one is the one to use, because the iPhone app talks plain
http only to addresses on your own networks, and iOS counts Tailscale's
IPv6 address as one and its IPv4 address as not. In `.env`:

```sh
BLOKS_BIND=[fd7a:115c:a1e0::1234]
BLOKS_PUBLIC_URL=http://[fd7a:115c:a1e0::1234]:8799
```

For the desktop app alone, the IPv4 address (`tailscale ip -4`) does as
well: `BLOKS_BIND=100.101.102.103` and
`BLOKS_PUBLIC_URL=http://100.101.102.103:8799`. Your tailnet's ACLs
decide who reaches it on top of that.

Or let `tailscale serve` give the server an https name on the tailnet,
which the desktop app takes as it is (HTTPS has to be turned on for the
tailnet):

```sh
tailscale serve --bg 8799
# in .env
BLOKS_PUBLIC_URL=https://homelab.your-tailnet.ts.net
```

## 5. Pair your devices

```sh
docker compose exec bloks bloks-server pair
```

prints, for each address in `BLOKS_PUBLIC_URL`, a link carrying that
address and a one time code, and a QR code for the first. It works once,
for five minutes.

- **Desktop app:** Settings, Phone and devices, Your servers: paste the
  link, Add server. The server becomes a workspace in the switcher,
  reached at that address with its own token. Turn off Run workspaces on
  this computer to make the app a window onto your servers alone.
- **iPhone:** scan the QR for an `http://` address on your home network or
  your Tailscale IPv6 address (step 4). The iPhone app does not pair at an
  `https://` address of your own yet; until it does, pair it on your VPN,
  or turn on Bloks Cloud for it (below).
- **A terminal elsewhere:** `bloks-server token --server
  https://bloks.example.com --code 123456` trades the code for a token for
  `bloks-server run`, `team` and `chat` on another machine.

Remove a device in Settings, Phone and devices, and its token stops
working at once.

## 6. Point Bloks at your models

### An OpenAI-compatible server (a self-hosted Qwen)

In `.env`:

```sh
BLOKS_MODEL_URL=http://host.docker.internal:8000/v1
BLOKS_MODEL_KEY=                     # if your server asks for one
BLOKS_MODEL_NAME=Qwen
BLOKS_MODEL_TOOLS=1                  # its model calls tools
```

then `docker compose up -d`. The engine is there, named Qwen, with the
models the server lists; pick it for an agent in the agent's settings.
`host.docker.internal` is this machine from inside the container. A model
server in the same compose project is reached by its service name
instead (`http://vllm:8000/v1`), one elsewhere by its address.

Tools are off until you say the model calls them: with vLLM, start it
with `--enable-auto-tool-choice` and the tool call parser for your model
(`hermes` for most Qwen models). More
servers, or keys to rotate, go in Settings, Engines, Your endpoints,
which make the same kind of engine.

### Ollama

```sh
OLLAMA_HOST=http://host.docker.internal:11434
```

and Bloks finds it as it starts, with the models it has pulled.

### Claude Code or Codex on your own server

The engine CLIs install from Settings, Engines (into the volume, so they
survive the container). Claude Code reads its own environment, so a
gateway that speaks Anthropic's API, LiteLLM in front of your Qwen for
one, is three lines of `.env`:

```sh
ANTHROPIC_BASE_URL=http://host.docker.internal:4000
ANTHROPIC_AUTH_TOKEN=...
ANTHROPIC_MODEL=qwen3-coder
```

To sign in to an engine with an account instead, open a shell there:
`docker compose exec bloks bash`, then `claude` or `codex login`. Or set
`BLOKS_OWNER_TERMINAL=1` and use the terminal from your own paired
devices.

### Hosted providers

A key in `.env` connects its provider: `OPENROUTER_API_KEY`,
`GEMINI_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`.

## 7. A desktop for your agents

An agent that needs a computer of its own (a browser it signs in to,
apps it clicks through) gets the Local VM: a Linux desktop kept apart
from everything else. On a Mac Bloks makes it with Docker; here it runs
beside Bloks as the `desktop` service, so Bloks is never handed the
host's Docker socket and nothing an agent runs can reach the host
through it. Uncomment one line in `.env`:

```sh
COMPOSE_PROFILES=desktop
```

then `docker compose up -d`. The first start downloads the desktop, which
takes a few minutes.
Settings, Computers, Local VM says Ready once it is up (and how to turn
it on until then), and an agent set to Local VM, or left on Automatic,
works it from its next turn. Its screen opens from that agent's
Computer panel in the desktop app, through Bloks: nothing of the
desktop is published, and its viewer's password is made fresh each
time it starts. Its files and browser sign ins live in the
`bloks-desktop` volume, so they stay when it is recreated. It has the
same limits as on a Mac: 4 GB of memory, 2 CPUs, and one agent at a
time.

To turn it off, comment the line out again and run
`docker compose up -d --remove-orphans`.

## When bloks.dev is down, or gone

Nothing here notices. With `BLOKS_CLOUD=off` the server never contacts
Bloks Cloud or bloks.dev, your devices talk to it at your address, and
your agents run on your engines and models. The things that are Bloks
Cloud's are simply not offered: reaching the server through Bloks
Cloud, bloks.dev/web, email to agents, WhatsApp, Live Activities on a
locked phone, Bloks AI, the Plan page, and the skill and team galleries
on bloks.dev (the Catalogue in this repository still works).
[SELF_HOSTING.md](SELF_HOSTING.md) has the whole list.

Even with Bloks Cloud on, it is only a road: agents run on the server,
and keep running when the relay cannot be reached.

## Bloks Cloud too, if you want it

`BLOKS_CLOUD=on` in `.env`, `docker compose up -d`, then

```sh
docker compose exec bloks bloks-server activate blok_live_...
```

`bloks-server pair` then prints your own addresses first and a Bloks
Cloud link after, for a device somewhere your address does not reach.

## Day to day

| What | How |
| --- | --- |
| Status | `docker compose exec bloks bloks-server status` |
| Logs | `docker compose logs -f bloks` (and `desktop`) |
| Update | `docker compose exec bloks bloks-server drain`, then `docker compose pull && docker compose up -d` |
| Stay on a version | `BLOKS_VERSION=3.2.1` in `.env` |
| Back up | `docker compose exec bloks bloks-server backup --encrypt`, then copy it out of the volume: `docker compose cp bloks:/home/bloks/.bloks-backups ./backups` |
| A shell there | `docker compose exec bloks bash` |
| Stop | `docker compose down` (the volume stays) |

An update never touches the volume. `drain` lets running replies finish
first; `docker compose up -d` without it stops them where they are, and
they pick up again when the new container starts.

## Troubleshooting

- **Pairing says the address cannot be reached.** Open
  `https://bloks.example.com/api/health` on the device. It should answer
  `{"app":"bloks",...}`. If it does not, the proxy or tunnel is not
  reaching the container.
- **`pair this device first` from your proxy.** The proxy reached Bloks;
  only paired devices get further, which is how it should be.
- **A bind-mounted `BLOKS_DATA` folder and permission errors.** It has to
  belong to uid 1000: `sudo chown -R 1000:1000 ./data`.
- **Live updates stall behind NGINX.** `proxy_buffering off` and a long
  `proxy_read_timeout`, as above.
