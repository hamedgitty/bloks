**Branch a conversation from any answer, signed webhooks, and an agent's browser that no longer stalls on a page's dialogs.**

## What changed

- **Branch from here.** Try another direction from any of an agent's answers: its ⋯ menu opens a new conversation that holds everything up to that answer, and the agent picks it up in a fresh session from there. The original stays exactly as it was, a line at the top links back to it, and files in the workspace are shared between the two.
- **Signed webhooks.** A webhook under Automations can now require a Standard Webhooks signature, with a secret Bloks generates or the one your sender gives you (Svix, Clerk, Resend, Composio and others), so the address alone is no longer enough. Unsigned, changed, stale or replayed requests are refused before they reach the agent, and the webhook's recent deliveries say why. The secret is shown once and never sent back.
- **Page dialogs no longer stall the browser.** When a page opens an alert, a confirm, a prompt or a "leave this page?", the agent is told what it says and answers it, in the desktop app and on bloks-server. While you have the browser, it shows as a small bar over the page for you to answer. One nobody answers is dismissed after 30 seconds, never accepted.
- **Missing MCP commands are reported.** An MCP server whose program is not on this computer shows "Command not found" in Settings, Plugins, with how to fix it. Turns leave it out instead of running without its tools in silence; the agent is told, and the conversation gets one notice. Bloks looks for the file and never runs it to check.
- **Reorder waiting messages.** Messages that wait while an agent or a room is busy can be moved: drag one by its handle, use Move up or Move down, or press Option (Alt) and an arrow. They go in the order you set, on every device.
- **⌘Q asks for a hold on a Mac.** One stray ⌘Q no longer stops your agents and routines: hold it for a moment or press it twice. Quit from the menu, the Dock, an update or logging out still quits at once, and Settings, General, Window turns it off.
- **Previews that keep up.** An open file preview updates in place when the agent, or anything else, rewrites the file. It keeps your place, says Updated, and says so if the file is removed.
- **Faster or slower voices.** Replies read aloud, calls and the morning brief can play at 0.75x to 2x at their natural pitch, set in an agent's Voice settings or with the chip on a call, kept per device.
- **Clean copy from the chat.** Copying a reply into Mail, Docs or Word brings its headings, lists, tables, links and code in the document's own style, without the app's colours, buttons or times.
- **OpenCode can keep to its workspace.** A workspace setting gives OpenCode its own config, data, state, cache and sessions instead of your personal ones, brings your OpenCode sign-ins in once, and lets you connect a provider for that workspace alone. Thanks @jrhorne (#485, #484)

## For people who build Bloks

- `POST /api/threads/:lane/branch` with `{ messageId, requestId }` (server/branch.ts): owner only, idempotent on the request id, refused for rooms, team, guest mail, Signal and rehearsal conversations. A branch's first turn is a new session told the copy (`freshTurnText` `why: "branch"`).
- Webhooks: `POST /api/webhooks/:id/signing` (`{ generate: true }` or `{ secret }`) and `DELETE` on the same path. The secret lives in `config.json` `webhookSecrets`, is on the backup secret list, and hooks report only `signed`. The ingress verifies `webhook-*` or `svix-*` headers on the raw body, a 5 minute window and a 10 minute replay memory.
- `server/mcp-command.ts`: a bounded file check of a stdio MCP server's command; `GET /api/mcp-servers` reports `missing`, and turns leave such servers out.
- Browser dialogs: `server/browser-core.mjs` races a step against a dialog on its tab and adds the `dialog` command (`accept|dismiss`, optional text); CLI `browser dialog`, MCP `browser_dialog`. The server browser uses `Page.javascriptDialogOpening` and `Page.handleJavaScriptDialog`; the app browser holds Electron's dialogs (`holdDialogs`).
- `POST /api/threads/:id/messages/:mid/move` with `{ before }` (server/queue-order.ts). Rooms now run waiting posts from a list each turn reads, instead of a chain fixed at posting.
- `GET` a shared file's route with `?version` answers `{ tag, size }` with no bytes; the viewer follows it (src/lib/followFile.ts).
- `electron/quit-guard.mjs`: the ⌘Q timing and its hint window; the app menu's Quit is now a custom item, and `prefs.quitGuard` holds the setting.
- `src/lib/cleanCopy.ts`: one copy and cut handler writing allowlisted HTML; mark chrome with `data-copy="skip"`.
