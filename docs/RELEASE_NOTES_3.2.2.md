**A Linux desktop for your agents on a Docker server, a security pass, and fixes for meetings, sign-in and the phone.**

## What changed

- **A desktop for agents on a server run with Docker.** The Local VM, an agent's own Linux desktop, now runs on a Docker Compose server as an optional `desktop` service beside Bloks: add `COMPOSE_PROFILES=desktop` to `.env` and `docker compose up -d`. Bloks is never handed the host's Docker socket, so nothing an agent runs can reach the host through it. Settings, Computers says how to turn it on and when it is ready, and the desktop's screen opens from an agent's Computer panel, through Bloks, with nothing of it published. The image is `ghcr.io/hamedgitty/bloks-desktop`. docs/DOCKER.md, step 7.
- **Watch a Local VM from another computer.** Open desktop in the Computer panel now works from a desktop app paired to a server, not only on the computer the VM runs on.
- **An agent can narrow what it reaches, never widen it.** An agent changing its own settings can no longer give itself your screen, another working folder, another engine, new MCP servers or your connected apps. It can still turn its computer off, give things up, rename itself and the like.
- **A server's own commands carry a key.** On `bloks-server`, a request on loopback is the owner only when it carries a key the server makes at each start, which `bloks-server` and the MCP bridge send themselves. A proxy or tunnel that hands a stranger to loopback no longer hands them the owner. A browser on the server itself pairs like any other device.
- **Watchers never look inward.** A page or feed a watcher follows can no longer redirect it to this server's own API, a cloud machine's metadata address, or into your network. A watcher you point at your own network or this computer still works.
- **Sign-in and members.** An address your identity provider says it has not verified no longer signs in as the member it names. Someone who joins from a browser and is let in later, after closing the tab, can sign in from any browser. A waiting browser that signs out takes its request with it. An admin can no longer let admins back into an agent's conversation the owner kept them out of.
- **Meetings never leave the microphone on.** Closing the meeting panel while it starts, or opening another agent mid-meeting, stops the microphone; a meeting left that way is written up from what was heard. Stop stays put if who hears changes during a meeting.
- **Plans with Bloks Cloud off.** A server with `BLOKS_CLOUD=off` now says on Plan and Members that plans come from Bloks Cloud, instead of a plan that could not load. Joining a workspace there looks only on your network.
- **Fixes.** Sign in again on an account already signed in keeps its instructions on screen, and the Accounts card no longer vanishes on one failed look. Choice rows (the effort levels in New agents) scroll on a phone instead of cutting off their last choices. Pairing choices no longer put brackets round a full web address. A file named inside a longer name is no longer carded in the wrong conversation, and a new turn in a conversation keeps the last one's claim on its files. A phone keeps the Live Activity it was left with.

## For people who build Bloks

- `BLOKS_DESKTOP` names the desktop service on the private network (`desktop` in `compose.yml`). `docker/desktop/Dockerfile` is written by `desktopServiceDockerfile()` in `server/local-vm.ts`, and a test holds them together; `container.yml` publishes it as `bloks-desktop` beside `bloks-server`. The service answers only the driver's version, health, a frame, its log, the viewer's password, and its MCP.
- The Local VM's viewer is passed through at `/local-vm/desktop/<ticket>/` under tickets of its own (`POST /api/local-vm/viewer`, never an agent's), as a hosted machine's desktop is.
- `server/local-key.ts`: `bin/bloks-server.mjs` sets `BLOKS_LOCAL_KEY=1`, and the server then writes `local.key` (0600) in its data folder and asks for it in `x-bloks-local` on owner requests from loopback.
- `server/agent-self-edit.ts` holds what `PATCH /api/bots/:me` lets an agent change about itself.
- `server/watched-fetch.ts` checks every hop of a watcher's fetch where it connects.
- CI: third-party actions are pinned to commits, and checkout keeps no token for the steps after it.
