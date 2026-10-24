**Agents say what computer they have, Codex stops chasing goals nobody set, and a held handoff reaches its agent.**

## What changed

- **An agent with no computer says so, and how to give it one.** Asked whether it can see the Local VM, an agent with no computer just said there wasn't one. Now it says why and what the person can pick in its settings, under Computer. On Windows and Linux, This computer is no longer offered, since working the PC's own screen needs a Mac; the Local VM and the cloud box are. Thanks @ThinkingSpade (#377)
- **Codex's own goals are off in Bloks.** A Codex agent could give itself a goal that Codex then tried to keep working on after every turn. Bloks cut that off each time, and the next turn opened telling the agent to keep going on a goal nobody held. Codex's goals are now off in the conversations Bloks runs, and one already set is cleared. Bloks goals are unchanged. Thanks @alexnayko (#380)
- **A message held at the turn limit goes with the next turn.** When a `bloks say` is held because agents reached the turn limit, the agent it was for now gets it, once, at the start of its next turn, whatever starts it. It still starts no turn and wakes nobody. Thanks @alexnayko (#376)
