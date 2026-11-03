**Agents work again on bloks-server, Codex gets its browser and computer, and your own server keeps a browser you can watch.**

## What changed

- **Agents' commands work on bloks-server again.** Since 3.2.3, on bloks-server and the Docker image, every command an agent ran against its own workspace (`whoami`, reading a skill, hiring, messaging another agent) failed with "pair this device first". An agent's own turn credential is now accepted from the server's own machine, as it is in the desktop app; strangers, members and the owner's own routes are unchanged. The desktop app was never affected. Thanks @po-trottier and @alexnayko (#480)
- **The Bloks browser on your own server.** On bloks-server or the Docker image with Chrome or Chromium installed, the browser beside the chat now runs on the server and shows live in the desktop app, at the web door and on your phone. Browse and sign in, hand the page to an agent, watch it work, take over and give it back, with tabs and sign-ins kept for that workspace. The same rules apply as in the app: owner only, Ask first, and a card before any password, payment or upload field. `BLOKS_BROWSER` names the Chrome to use, or turns it off. (#479)
- **Codex agents get their browser and computer.** An agent on Codex now has its own browser and its computer (the Local VM, this Mac or the cloud box) as tools, the same as on Claude Code, on new and resumed conversations, including when it works in a container or over SSH. Turns for other people never get them. (#482)
- **Codex in a container or over SSH finds its commands.** A Codex agent working in Docker or over SSH now gets the Bloks command line and address of that place in its shell, not this computer's. Thanks @kevinovertoom (#483, #481)

## For people who build Bloks

- `server/index.ts`: a request identified as an agent's turn credential is local when it arrives on loopback, without `x-bloks-local`. Owner scripts on a server send the key from `local.key` as `x-bloks-local` (docs/SELF_HOSTING.md).
- `server/server-browser.ts`: a server with no desktop line and not hosted keeps a headless Chrome in `<data>/browser-session`, behind the same `AppBrowser` and rules as the app's. The shared code moved to `server/browser-core.mjs`; `electron/app-browser.mjs` re-exports it. New owner routes `POST /api/browser/viewport`, `GET /api/browser/screen?after=N` (long poll for screencast frames), `POST /api/browser/input`, `POST /api/browser/do` and `GET /api/browser/downloads/:id`. `GET /api/browser` says `where` and, when it cannot run, `missing`.
- `server/drivers/codex.ts`: `screenConfig()` mounts `bloks_browser` and `bloks_computer` in the thread config, through the workplace gate when working elsewhere; `CodexDriver` declares `screens: ALL_SCREENS`.
- `Workplaces.begin()` returns the environment it prepared, and the turn uses it.
