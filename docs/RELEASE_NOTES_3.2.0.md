**Several servers in one desktop app, a self-hosted mode that says so, more than one account per engine, private chats that stay private in a shared workspace, and two new engines.**

## What changed

- **Several of your servers in one desktop app.** Pair as many `bloks-server`s as you like under Settings, Phone and devices, Your servers, name them, and switch with the workspace menu or Ctrl (⌘ on a Mac) and a number. Turn off Run workspaces on this computer and the app runs no agents of its own. An existing connection is carried over on its first start. Thanks @po-trottier (#428)
- **Self-hosted servers say so.** A `bloks-server` of your own now shows as Self-hosted, not Hosted. `BLOKS_OWNER_TERMINAL=1` opens its terminal to your own paired devices, and `BLOKS_HOSTED=1` now means only a machine a provider runs for you. docs/SELF_HOSTING.md has the setup and the move from `BLOKS_HOSTED=1`. Thanks @po-trottier (#442)
- **Update a systemd-run server from the app.** With a `versions/` folder the service account owns and `Restart=always`, Settings, About installs new server versions through systemd, without root, and goes back to the previous version if the new one does not start. It needs one update by hand to 3.2.0 first. Thanks @po-trottier (#396, #430)
- **Keep your model through a plan limit.** Sign in to more than one Claude Code or Codex account under Settings, Engines and keys. When the account in use reaches its limit, the next turn starts on another one with the same model, effort, tools and approvals, in a new session told the conversation so far. Usage shows which account ran what. Thanks @rpavlovs (#465)
- **Private means private in a shared workspace.** In a member's private chat an agent now keeps a memory of their own and works in a folder of their own, and looking back only finds what that person could already read. The owner's chats, search and recall never pull a member's private words. Each member connects their own apps and keys under Your connections, used only in their own private chats, and is welcomed once with what is shared and what is theirs. Thanks @po-trottier (#431, #386)
- **Your phone stays quiet while you're at your computer.** While you're actively using Bloks on a desktop or in a browser, your phone gets no notifications or new Live Activities, and any already showing end quietly; step away and they come back. Thanks @po-trottier (#443)
- **Pair your iPhone over Tailscale.** Bloks now also listens on your computer's Tailscale IPv6 address (local IPv6 only, never a public one), and the pairing card lets you pick which network the code uses. Thanks @jrhorne (#449)
- **Command Code and Devin are built-in engines.** Install and sign in from Bloks, pick each agent's model and reasoning level, Off included, and their questions always come to you, even in full auto. Thanks @po-trottier (#432, #458)
- **Agents can make a skill and use it.** Ask an agent for a skill and it sends the whole thing, files included, on one card in the conversation; Add puts it in your library and gives it to that agent. Skills can now keep supporting files, like an API reference or a helper script, read only when needed. Thanks @po-trottier (#455)
- **Things to do from your routines.** When a routine's report finds something only you can do, its agent puts it on your list once, however many mornings it reports it. It waits in the brief's Waiting on you section and counts in the morning notification until you mark it done or dismiss it. Thanks @po-trottier (#430)
- **Edit a routine on desktop.** Routines have an Edit action in their details and in each routine list, and only what you change is saved, so the routine keeps its history. Thanks @po-trottier (#456, #453)
- **Keep Bloks running in the Windows tray.** Settings, General, Window has a switch so the close button hides Bloks to the system tray. Click the icon to bring it back, or right-click it to quit. Thanks @po-trottier (#457, #446)
- **Add to a request while it gets ready.** What you send while an agent is still starting a turn joins that turn instead of waiting for its first answer. Bloks never resends words whose delivery it could not confirm; you can dismiss them from the waiting list. Thanks @rpavlovs (#414)
- **Stop and send now sends your draft first.** Ctrl+Enter or ⌘Enter while an agent works starts the next turn with your draft alone, and messages that were already waiting follow in order, each once. Thanks @po-trottier (#454, #452)
- **Your queued words get the answer.** When your messages wait alongside other agents' messages, they go in last and marked as yours, and a bare QUIET is never shown as the reply to you. Thanks @alexnayko (#461)
- **Agents can finish quietly on purpose, and take back a question.** `bloks quiet` ends a turn nobody is waiting on with no message, after Bloks checks nothing in it was meant for you. A Codex agent can withdraw a question it asked without waiting once it is settled some other way (`bloks questions`, `bloks unask`). Thanks @rpavlovs (#463, #423)
- **Wakes from your own scheduler.** A program on your computer can start work in one exact conversation, labelled as a local service rather than as you, and a quiet result stays quiet. Thanks @rpavlovs (#426)
- **Files stay in the conversation that made them.** When two conversations of one agent work at once, a file one of them saves becomes a card only there. Thanks @po-trottier (#460)
- **Plan notices say which limit.** The message box names the window ("5-hour limit", "Weekly limit, Opus") and counts down the hours and minutes once the reset is under a day away. Thanks @rpavlovs (#440)
- **Usage shows only engines you use.** An engine that is not installed no longer appears in Usage or its plan cards, and a turn it never ran no longer counts. Thanks @po-trottier (#459)
- **Long conversations are summarised whole.** Every message of a fold is read, in order, so a decision made in the middle is no longer lost, with the number of summary requests kept bounded. Thanks @rpavlovs (#462)
- **One set of marks for conversations.** Tabs and sidebar rows share the same marks: a blue pulse while working, amber when waiting on you, green when finished and not yet opened. Tabs also stay right through Bloks Cloud when the agent list arrives late. Thanks @po-trottier (#451, #448)
- **Bloks names your computer as it is.** On Windows and Linux, Settings, moves, joining and leaving say this PC or this computer instead of this Mac, in every language. Thanks @po-trottier (#450, #429)
- **Right install commands on Windows.** Every engine shows its maker's own PowerShell or npm line on Windows, such as `irm https://claude.ai/install.ps1 | iex`, instead of a Mac command. Thanks @AmirIsADevProlly (#438)
- **Finished watchers make room.** A watcher that acted once or ran out of time no longer blocks a new one at the limit of fifty; paused watchers are never touched. Thanks @pycckuu (#464)
- **Clearer check watchers.** The help says a check's first run is a baseline and it acts only on something new, and points interval wake-ups at `routine --every`. Thanks @alexnayko (#424)
- **Antigravity says why a turn failed**, and a resumed conversation counts only what the new turn used. Thanks @ReffWu (#439)
- **Replies stay in the chat column**, the answered question included, instead of running off the edge. Thanks @po-trottier (#447)
- **Tighter prompts for guests and screens.** Agents keep ordinary answers in the chat, are told not to get around a screen kept from them, and unlisted mail is not told how to ask for a connection or a key. Thanks @rpavlovs (#427)
- **The Mac Dock icon is the right size.** Thanks @ReffWu (#422)

## For people who build Bloks

- `server/deployment.ts` describes where a server runs and who manages it; `/api/config` has a `deployment` section and `/api/health` names `managedBy`. `BLOKS_OWNER_TERMINAL=1` is set where the server runs; no device can turn it on.
- `bin/bloks-server.mjs` runs a trial after an update and rolls back on a failed start; it refuses a `versions/` folder that is world-writable or owned by another account.
- `/api/engine-accounts` (owner only; add, sign in and remove on this computer only). Account folders live under the data folder's `engine-accounts/` and are left out of backups and moves.
- Member-owned keys and apps live in `people/<id>/own.json`; a member's private memory and working folder in `people/<id>/agents/<bot>/`.
- New agent commands: `bloks quiet`, `bloks questions`, `bloks unask`, `bloks skill create`, `bloks skill request`, `bloks todo`, `bloks todos`, `bloks untodo`. `/api/todos` and `/api/skill-requests` are on the agents' never list.
- The local service wake route accepts only a direct loopback request with no Origin and no Authorization header; see SECURITY.md.
- `POST /api/presence` takes a window's active or not; it is kept in memory only, refused to agents and members, and listed as feature `presence`.
- The server listens on IPv6 too and drops any IPv6 peer that is not loopback, unique-local or link-local before reading from it.
- `server/engine-commands.ts` holds each engine's install and update line for Mac and Linux and for Windows.
- Dependencies: motion 14.6, @radix-ui/react-tooltip 1.4.1, @trycua/cua-driver 0.37.0, electron-builder 26.18.0, electron-updater 6.8.11, posthog-js 1.438.23.
- The pairing proof and reserve tests are deterministic. Thanks @rpavlovs (#441, #425)
