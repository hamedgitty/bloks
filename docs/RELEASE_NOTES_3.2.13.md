**Telegram keeps the whole answer when a request waited its turn, and the terminal panel finds its shells again after a dropped line.**

## Fixes

- **Telegram no longer drops the answer inside an interface.** A request sent from Telegram while the agent was busy waits its turn, and its answer went back with only the words around any interface the agent drew, so a recommendation or a table inside it never arrived and nothing said so. It now comes across as text, the same way an answer to a request that didn't wait does, and where the agent isn't allowed to show interface, the message says something was left out. Thanks @alexnayko (#547)
- **The terminal panel reconnects by itself.** When the first answer to the panel's stream wasn't a stream (a server still starting, or a proxy or Bloks Cloud losing the machine for a moment), the browser gave up on it for good, and the panel sat empty under "Lost the connection to the shells. Trying again." with nothing trying. It now tries again, a little later each time, and the shells come back as soon as the server answers. Thanks @alexnayko (#552)
