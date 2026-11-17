**One side dock beside every chat, workspace extensions, topics in rooms, and agents that know who they report to.**

## What changed

- **One side dock.** Documents, the Bloks browser, a terminal on the right, the agent's computer and a turn's timeline now share one column beside the conversation. A row of small icons switches between them, one edge sizes it, and an X hides it with everything kept. It remembers per conversation whether it's open, what it shows and which documents are in it. Cmd+Option+B (Ctrl+Alt+B elsewhere) shows and hides it. View on a file card opens the file in a tab there, and web links in replies open in the Bloks browser beside the chat; Cmd or Ctrl with the click still opens your own browser. Thanks @pycckuu (#509) and @iamvince (#522)
- **Workspace extensions.** The owner can install an extension into a workspace from Settings, Plugins, Extensions: panels in the side dock, commands in search, handlers for a few workspace events, and settings. Every permission is shown in words before you install, and the install is refused if the folder changed since you looked. Each extension runs in a sandbox with no network and never reaches a secret, a connection or an agent's credential. The guide for authors is `docs/EXTENSIONS.md`. Thanks @pycckuu (#507) and @iamvince (#524)
- **Chrome extensions in the Bloks browser.** In the desktop app, the owner can add an unpacked Chrome extension to one workspace's browser from Settings, Browser. Before you add it, you see what it can read and change and what works here. Toolbar popups and native messaging don't work in Electron yet, so most password managers load but can't unlock; the page says so. Thanks @pycckuu (#510)
- **Topics in rooms.** A room can hold topics: named pieces of work, each with its own thread, the agents who work in it, and the folder and branch its work belongs in. The owner, workspace admins and the room's lead open and close them. A topic's details open in the room's side dock. Thanks @iamvince (#523)
- **Agents and teams.** A new Agents page lets the owner give each agent a lead and a line on what to contact it for, with rooms listed as teams. Agents read it with `bloks org` and `bloks who`. An optional rule has them go through their lead before messaging across teams. Thanks @iamvince (#525)
- **A turn scrubber.** A slim rail beside chats and rooms has one tick per turn. Hover a tick to preview that turn, click to jump there, or use the arrow keys. It holds up in very long conversations. Thanks @iamvince (#521)
- **Compact agent rows.** A switch in Settings, General shows each agent in the sidebar as one short line with its name, a spinner while it works, and its waiting and unread marks. Off by default. Thanks @pycckuu (#508)
- **Bloks Cloud reconnects on its own.** A workspace could lose Bloks Cloud for hours until its server restarted. It now gets a fresh connection whenever a dial fails, and when you turn Cloud off and on. Thanks @pycckuu (#506)
- **Joining a shared room from its invite link.** Open in Bloks on a room's invite page now opens the join dialog in the desktop app, rather than doing nothing. Thanks @theowl369 (#516)
- **The terminal works through a direct pairing.** With the app paired to a server by its address, the terminal panel never loaded. It now streams. Thanks @beauloxe (#520)
- **Model proposals.** `bloks models propose` takes a typed Claude model id the picker would take, and `bloks models withdraw` lets an agent close its own unanswered card. Thanks @alexnayko (#517, #518)
- **Claude Fable 5.2** is in the Claude model list, with its 1M token context. Thanks @jrhorne (#502)

## For people who build Bloks

- Electron 45. It reports screen capture to the permission handler as `display-capture`, which the app's default session now grants.
- A test's server no longer inherits the `BLOKS_LOCAL_KEY` that bloks-server sets for its agents. Thanks @rpavlovs (#504)
- Extensions: `server/extensions.ts`, `server/extension-routes.ts`, `src/lib/extensions.ts`, `src/components/extensions/`. The side dock is `src/lib/dock.ts`. The org chart is in `registry.json`, with MCP tools `org_chart` and `who_to_contact`.
- Dependency updates: motion 14.11.1, @openuidev/lang-core 1.1.0, Tailwind CSS 4.3.5, playwright-core 1.65.0.
