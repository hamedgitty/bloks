**A side dock that works like panes, models changed with one instruction in chat, teams you can build, and Chrome extensions you can unlock.**

## What changed

- **The side dock works like panes.** Panels are tabs, and a + button opens Files, Changes, Browser, Terminal, Background tasks, Computer or Timeline. Each tab can move to the left, right, top or bottom, so the browser can sit on the right with terminals along the bottom, each pane with its own tabs and expand (Shift+Cmd+Backslash). Every shell and browser page is a tab of its own, and long tab rows scroll and fade at their edges. In the desktop app, Files, Changes and Background tasks can open in a window of their own. Thanks @iamvince (#522)
- **Changes and Files.** Changes lists every file the agent changed in the conversation, with a diff, and opens any file at a line, plus your uncommitted changes when the folder is a git repo. Files shows the agent's shared files as a tree you can filter. (#522)
- **Agents' own terminal tabs.** An agent can run a long command, such as a dev server, in a terminal tab of its own that you can watch and type in, and read back only its own tabs, never yours. It can also bring a panel to the front for you in the conversation it's answering. An empty browser tab lists the local addresses its servers printed, and Background tasks shows what it has running. (#522)
- **The conversation in the top row.** On a wide window the agent's or room's name sits in the window's top row beside your workspace, with the dock's tabs in the same row, and the dock runs straight up to the top. (#522)
- **Change agents' models with one instruction.** Tell an agent in your own chat "update all models from X to Y" or "upgrade them to the new version", in English or Ukrainian, from the app, a paired device or your private Telegram chat. The server reads your message itself, changes only the primary model of your own agents on the engines they're already on, all at once or not at all, and reports each change back in the chat. Questions, quotes and negations never run, and each message works once. Thanks @rpavlovs (#544)
- **Request share.** A file link that wasn't shared into the chat now offers Request share, which puts a request naming the exact file in the composer for you to send. Try again only shows for connection errors. Thanks @pycckuu (#543)
- **Build teams.** The Agents page has a New team button, and each agent's card shows its model, skills and teams, with Make lead and Move to team. Thanks @iamvince (#525)
- **Leads route work into topics.** The owner can let a room's lead move a message into an open topic or open one for it, always said in the main stream. A topic's folder is held for Claude Code's own file edits, and a workflow step can open a new topic each run. Thanks @iamvince (#523)
- **Chrome extensions you can unlock.** In the desktop app the Bloks browser has an extensions button that opens an extension's popup or options page in a small window of its own, so a password manager can be unlocked. Agents can't see or use those windows, and they're kept out of screen capture. A server's own browser now takes extensions too. Thanks @pycckuu (#510)

## Security

- **An agent's message to itself is never read as yours.** A message an agent wrote to itself, or a job it posted, was saved like a message you typed, so it could start a turn as yours (with your notifications and recall of your other conversations), reset an agent's turn limit, and be edited or redone as your own. These messages are now marked by the server and shown as the agent's.
- **Extension pages stay out of agents' tabs.** An extension could put its own page into a tab an agent reads; such a page is now turned away and agent commands are refused on it.

## Fixes

- A server's browser started service workers paused and never let them run, so sites' workers and extensions' backgrounds never answered.

## For people who build Bloks

- New agent commands: `bloks dock show`, `bloks terminal run|read|list|stop`, `bloks models apply-instruction`, `bloks topics`, `bloks topic open|close|reopen|move`. The model catalog has a `successor` field.
