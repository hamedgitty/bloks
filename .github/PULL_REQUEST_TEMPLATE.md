<!--
Thanks for the pull request. Keep it to one thing if you can, and tell us
what you verified. Delete any section that does not apply.
-->

## What this changes

<!-- One or two sentences. What is different after this merges? -->

## Why

<!-- The problem, or the reason the old behaviour was wrong. If it fixes
an issue, link it: Fixes #123 -->

## How you verified it

<!-- The most useful part of this template. What did you actually run?
"Sent a turn through Gemini CLI, the approval card blocked until I
answered, rejecting it skipped the tool" beats any description of the
diff. If you could not verify part of it, say which part. -->

- [ ] `pnpm typecheck` passes
- [ ] `pnpm build` passes
- [ ] Ran the app and used the changed surface

## Screenshots

<!-- Required for UI changes. Light and dark if the change touches
colour, spacing, or layout. -->

## Anything a reviewer should push back on

<!-- Tradeoffs you made, things you were unsure about, anything you would
do differently with more time. Saying "I am not sure this is the right
place for it" is welcome and speeds review up. -->

---

- [ ] I read [CONTRIBUTING.md](../CONTRIBUTING.md)
- [ ] This does not weaken the approval gate, or it does and the body
      above explains why that is correct
- [ ] Any new field that reaches disk or a system prompt has a length cap
