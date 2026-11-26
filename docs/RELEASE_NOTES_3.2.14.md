**Antigravity runs every turn over ACP, a routine you stop is no longer a failure, and Bloks is on Google Play.**

## What changed

- **Antigravity runs over ACP for every turn.** Antigravity turns now go through `agy acp`, the same way Bloks runs its other ACP engines, instead of print mode. Connected apps, workspace MCP servers and the Bloks browser and computer reach Antigravity turns, approvals are real questions you answer, the answer streams in as it is written, and a conversation picks up where it left off instead of replaying itself. Approval cards show the command or path Antigravity wants to use, with the usual warning on a risky command. Every turn follows your own approval rules, so Ask asks a little more for edits than before and Auto asks a little less. Agents saved on an older Antigravity model name, such as `gemini-3.1-pro-high`, move onto that model with the matching effort. Antigravity now needs `agy` 1.5.13 or later. Thanks @pycckuu (#550), and @wwCarl for tracing what print mode got wrong (#542, #546) and for the approval card fix (#548, #549)
- **Bloks is on Google Play.** The Android app is a window onto the agents on your computer, like the iPhone app, and pairs the same way. [Get it on Google Play](https://play.google.com/store/apps/details?id=dev.bloks.app).

## Fixes

- **A routine you stop is no longer a failure.** Stopping a routine's turn yourself, with Stop, Send now or words that stop it, recorded the run as failed and raised an incident asking you to act, even when the next turn finished the work, and no agent could settle it. A routine turn you stop is now recorded as stopped, shown in grey with no error, is not counted toward the routine pausing itself, and raises no incident, the same as any other turn you stop. Thanks @alexnayko (#553)
