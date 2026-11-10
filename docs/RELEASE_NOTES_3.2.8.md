**Approvals that work on Windows, model changes an agent can propose, and summaries that forget what you take back.**

## What changed

- **Approvals work on Windows.** On Windows, every approval an agent on Claude Code asked for, a web search or reading a screenshot or file you shared among them, was refused with "permission broker unavailable", whatever you restarted. The channel that brings those questions to you now opens there, and the Windows build checks it before every release. Thanks @ericwfranklin1 (#501), and to everyone who wrote in about it.
- **An agent can propose model changes for you to approve.** `bloks models propose` puts one card in front of you listing each agent's engine and model now and the one proposed, with any engine switch marked. Unknown agents, engines and models are refused with the reason. Nothing changes until you press Apply, and then every change is made or none is. Thanks @pycckuu (#497)
- **A summary forgets what you take back.** Deleting or editing a message an earlier summary read now drops that summary, so the old words are not told again and the message after it is no longer lost. Thanks @rpavlovs (#499, #500)
- **A turn can finish quietly past an old question.** A question an earlier turn left open no longer stops a later turn from finishing without a reply, and the unread dot comes back when nothing was said. Thanks @rpavlovs (#498)

## For people who build Bloks

- `bridgeSocketPath` returns a named pipe under `\\.\pipe\` on Windows; `test/windows-bridge.test.ts` runs in the Windows build.
- Model proposals: `server/model-proposals.ts`, `bloks models`, `bloks models propose`, `bloks models proposal <id>`. The answer route is owner-only and never reachable by an agent.
