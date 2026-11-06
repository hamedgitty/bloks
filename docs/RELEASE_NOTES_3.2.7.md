**Bring your OpenBot agents across, answer several questions on one card, and pick up exactly where you left off.**

## What changed

- **Bring your setup reads OpenBot.** Its agents come over with their names, pictures, instructions, skills and memories, each one previewed before anything is added. Pick an OpenBot transfer file (in the app, or uploaded from a browser on bloks-server) for workspace files and routines too; routines arrive paused until you switch them on. Chat history, channels, saved logins and connectors stay where they are, and the screen says so. Like every import, it can be undone.
- **Several questions, one card.** When an agent asks a few things at once, one card steps through them, each with its own choices (one or several) and room for your own words. Every answer goes back against its own question, and when the agent's words before asking have scrolled out of view, the card carries them.
- **Link a conversation or a tab with @.** In an agent's conversation, type @ to drop in another of your conversations or a page open in the Bloks browser. The agent is given its summary or the page's text, framed as outside content and kept short, and only what you could open yourself is read.
- **Quote exactly what you mean.** Select words in any message and press Quote (or ⌘') to reply with just those words. On an agent's answer, Branch with this opens a branch with the quote waiting in its box.
- **Pick up where you left off.** A New line marks what arrived since you last read a conversation, on every device, and the chat opens there when there is more than a screen of it. Mark unread from here keeps a reply for later. Your place is yours alone in a Team workspace.
- **Watchers never drop a finding.** A watcher at its hourly limit now holds what it found and acts on it as soon as the limit allows. Each watcher sets its own limit, from 1 to 30 turns an hour, and keeps its last fifty looks, so you can see what it found, held back or skipped. Thanks @alexnayko (#496)
- **Custom endpoints explain themselves.** An endpoint whose model list fails shows why, in the host's own words, with Retry, and is not offered as ready until a list arrives. Endpoints can carry up to ten headers of their own, kept like keys, and can say their model takes a reasoning effort. Thanks @pycckuu (#486)
- **Commands are found where your shell finds them.** The desktop app now keeps your login shell's PATH even when the shell is slow or its last line fails, and looks in the cargo, Bun, Go, mise, asdf, pyenv and MacPorts folders, so an MCP server no longer shows "Command not found" for a command you have.
- **Answers come back to the tab that asked.** When one agent hands work to another from a side conversation, the answer lands in that conversation, even after a restart. Agents can name only conversations they are part of, and an agent hears when words it left waiting were dropped. Thanks @jrhorne (#495, #493, #494)
- **Smaller things.** Sidebar headings stay pinned as you scroll, and the browser pane closes with your last tab.

## For people who build Bloks

- Bring your setup: source `openbot` in `server/setup-import.ts`. It reads `~/OpenBot/Agents`, the app data folder's `openbot.db` (read only, `projection_agents.agent_json`, through a guarded `node:sqlite`), and a transfer file uploaded to `/api/setup-import/transfer/uploads` and read by `server/zip-read.ts` with hard limits. `bloks-server import openbot --dry-run [--transfer FILE]`.
- Questions: cards keep every existing field and add `questions`, `agentSaid`, `agentSaidId` and `answers`. `/respond` takes `answers` (one list per question); the old single answer still answers the first question. Feature `question-steps`.
- Mentions: chips go out as `[@Label](bloks://agent/<id>?lane=<lane>)` or the tab's URL. The server reads each with lane access, within 5 mentions and 16,000 characters per message; the browser gains `peek`, which reads a tab without driving it.
- Replies: `ReplyRef.quote`, up to 2,000 characters.
- Last read: `server/last-read.ts`, `POST /api/threads/:id/last-read` and `/unread-from`, and `POST /api/member/threads/:id/last-read`.
- Watchers: `perHour` (1 to 30; through an agent's credential at most 6, or a higher limit the person set), `GET /api/watchers/:id/looks`, `bloks watch-history <id>`, history in `watcher-looks.jsonl`.
- Custom endpoints: `PUT /api/custom-endpoints/:id/headers`, `POST /api/custom-endpoints/:id/models` (retry), `catalogError` on the engine's status, `reasoningEffort`, and `BLOKS_MODEL_EFFORT=1`.
- Agent lanes: `agentLaneRefusal` holds every route an agent names a lane on (messages, show, artifacts, rename); `TaskRecord.peerLanes` and `createdBy`; `AgentNote.laneId` and `dropped`.
- PATH: `electron/shell-path.mjs` reads the login shell between markers and retries once in the background; servers take a late PATH with `adoptPath`.
