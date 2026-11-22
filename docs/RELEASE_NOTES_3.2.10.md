**Antigravity agents that can run commands and work past ten minutes, steered words that are never lost, and more of the side dock, agents and topics.**

## What changed

- **Antigravity runs commands on Auto.** An agent on Auto approvals now runs agy in its own Auto mode, so commands go ahead instead of being refused every time, and Full access still skips permissions. Ask and Edits keep accept-edits, since agy's print mode can't show an approval card. Thanks @ethnmz (#542)
- **Antigravity turns no longer stop at ten minutes.** A tool step that goes silent ends the turn on the stall limit instead, and Stop makes sure agy and everything it started have ended. Thanks @pycckuu (#528, #532)
- **Antigravity's model list keeps up.** It is read again from `agy models` as Settings checks the engine and whenever agy refuses a model, so a plan upgrade shows up without a restart. An agent whose saved model is no longer offered runs on the default and is told so, instead of failing every turn. Thanks @ethnmz (#542)
- **Words steered into a turn are never lost.** A message steered into a Claude Code turn now waits for the engine to confirm it read it. If the turn is stopped, stalls or crashes first, the message starts the next turn, with a line saying why. The label now says the message is read after the current step. Thanks @alexnayko (#527)
- **Computer use in a container of Bloks' desktop image.** Bloks now runs everything there as the image's own user, so the desktop driver accepts it and the agent gets its screen. The Test checks the driver answers before it says Ready, and the contradictory warning is gone. Thanks @codiak (#541)
- **Chat links open where they can.** When the workspace's browser can't open pages, a plain click on a chat link opens your own browser. Settings, Browser has a new "Open chat links in" choice. Thanks @alexnayko (#539)
- **`memory --write` keeps text that starts with a dash.** The agent CLI's value flags take the next argument even when it starts with `-`, so frontmatter is no longer written as `true`, and `--` ends the flags. Thanks @codiak (#540)
- **Search archived agents.** The Archived agents dialog has a search field for a name or role. Thanks @pycckuu (#538)
- **The side dock** opens on the computer when an agent in the chat starts using it, by the same rule as browsing, and each icon shows a dot: orange when something waits on you, purple when someone else is at it in a shared room, blue while an agent works. In a chat the browser can show only that agent's tabs. Thanks @iamvince (#522)
- **Agents and teams.** The sidebar's Agents heading has a Favorites and All switch, and the Agents page lists archived agents with one-click Restore. Thanks @iamvince (#525)
- **Room topics.** A workflow's "Post in a room" step and a room's routine can post into a topic, topics fold into category folders, and members see topic changes live. Thanks @iamvince (#523)
- **Telegram replies show the interface content** of an answer, tables included. Thanks @rpavlovs (#503)
- **Translations.** The strings 3.2.9 added in English only are now in every language the app ships.
- The README links the Bloks Discord near the top. Thanks @iamvince (#531)

## For people who build Bloks

- Tests can no longer write into a real workspace: every test file starts with the workspace variables (`BLOKS_DATA_DIR`, the port, address, token and local key) removed, and the server refuses a data folder outside the temp folder under the test runner. Thanks @pycckuu (#529)
- Dependency updates: motion 14.14.0, @openuidev/lang-core 1.1.1, @openuidev/react-lang 1.1.1, posthog-js 1.450.0, and the dev-dependencies group.
