# Tests

```sh
pnpm test          # everything, about a minute and a half
pnpm test:watch    # rerun on change
node --test test/rooms.test.ts   # one file
```

No test framework. Node's built-in runner reads TypeScript directly, so
there is nothing to install and nothing to configure.

## What is here

| File | Covers |
| --- | --- |
| `http-guard.test.ts` | The origin and host checks. The security boundary. |
| `limits.test.ts` | Caps on anything reaching disk or a prompt. |
| `teams.test.ts` | Parsing a team plan out of model output. |
| `rooms.test.ts` | Who an `@mention` in a room actually wakes. |
| `skills.test.ts` | Skill filenames, and path traversal. |
| `house-style.test.ts` | The dash scrubber, and what it must not touch. |
| `models.test.ts` | Narrowing a provider's model list. |
| `reducer.test.ts` | Client state: where a message lands, cards settling. |
| `policy.test.ts` | Which rule answers, and what the wheel refuses. |
| `workflows.test.ts` | Steps, conditions, and what a bad one is refused for. |
| `activity.test.ts` | What a lane has stopped on, and what still wants you. |
| `components.test.ts` | Model-written JSON, checked before it reaches a screen. |
| `palette.test.ts` | The colours, against the contrast they promise. |
| `api.test.ts` | The real harness over real HTTP. |

## How to write one here

**Test the property, not the implementation.** A test named "the longest
matching name wins" survives a rewrite of the matcher. A test named
"calls sort() before includes()" does not, and it found nothing when the
matcher was wrong anyway.

**Say why in the test.** When an assertion exists because of a specific
failure, put that failure in a comment. Someone will eventually want to
delete the line, and the comment is the only thing that will stop them.

**Prefer the real thing.** `api.test.ts` boots the actual server against a
throwaway home directory with no credentials and an empty `PATH`, then
makes the requests a browser would. Mocking the request path would have
tested the mock.

**Untrusted input deserves the ugly cases.** Model output, skill names and
anything from a page are attacker-shaped. The interesting assertions are
the ones about what must *not* get through.

## The integration harness

`helpers/server.ts` spawns `server/index.ts` with `HOME` pointed at a
temp directory, a random port, blanked credentials and `PATH=/nonexistent`
so no provider CLI can be found. That last part is deliberate: it puts the
server in the state a brand new user is in, which is where several of the
interesting behaviours live.

It cleans up after itself, and retries the cleanup: the server can
outlive its own SIGTERM by a moment, and removing the home while it is
still writing raises ENOTEMPTY, which fails a test that had already
passed. If a run is killed halfway, stale directories are under your
system temp as `bloks-test-*`.
