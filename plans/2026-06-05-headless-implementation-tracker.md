# Headless Mode Implementation Tracker

## Current Milestone

Implement the headless command surface first.

This milestone shall cover:

- `kimi headless run` option parsing.
- `kimi headless --goal` shortcut parsing.
- `kimi headless status` parsing.
- `kimi headless goal pause|cancel|interrupt` parsing.
- main entry routing to the headless handler.
- prompt-mode regression coverage for `kimi -p`.

## Progress

- [x] Command parsing tests written.
- [x] Command parsing tests fail for the missing feature.
- [x] Command parsing and routing implemented.
- [x] Focused tests pass.
- [x] CLI help checked.
- [x] Self-contained commit created: `4d26627 feat: add headless command surface`.

## Current Milestone 2

Implement headless status, output-file, control, and approval helpers.

This milestone shall cover:

- Atomic status file writes and reads.
- Status file preflight.
- Metadata header formatting.
- Output directory resolution.
- Atomic response and goal-status file writes.
- Control request writes and reads.
- Non-fatal unused plan flag warnings.

Goal control semantics:

- `pause_goal` shall match TUI `/goal pause`: finish the current turn, then stop before the next goal turn.
- `cancel_goal` shall finish the current turn, then cancel the goal before the next goal turn.
- `interrupt` shall stop the active turn immediately and leave the goal paused when possible.

## Milestone 2 Progress

- [x] Helper tests written.
- [x] Helper tests fail for missing modules.
- [x] Helper modules implemented.
- [x] Focused tests pass.
- [x] Typecheck passes.
- [x] Self-contained commit created.

## Current Milestone 3

Add SDK session run locking.

This milestone shall cover:

- `packages/node-sdk/src/session-lock.ts`.
- `acquireSessionRunLock` exported from the SDK.
- `session.locked` public error code.
- Live lock rejection.
- Dead-pid stale lock replacement.
- Guarded release that does not remove another run's lock.

## Milestone 3 Progress

- [x] Lock tests written.
- [x] Lock tests fail for missing helper.
- [x] Lock helper implemented.
- [x] Focused tests pass.
- [x] Typecheck passes.
- [x] Build passes.
- [x] Self-contained commit created.

## Current Milestone 4

Wire headless status and goal-control commands.

This milestone shall cover:

- `runHeadless` status dispatch.
- Human status summary output.
- Raw status JSON output.
- Goal control request writes through `status.control.path`.
- Fail-safe rejection when a status file has no control path.

## Milestone 4 Progress

- [x] Command behavior tests written.
- [x] Command behavior tests fail for the stub.
- [x] Status and goal-control commands implemented.
- [x] Focused tests pass.
- [x] Typecheck passes.
- [x] Build passes.
- [x] Self-contained commit created.

## Current Milestone 5

Implement one-turn prompt-backed `headless run`.

This milestone shall cover:

- New-session prompt runs.
- `--cwd` for new sessions.
- `--session` cwd validation.
- Session run lock acquisition and release.
- Status file updates.
- Default JSON metadata header plus Markdown.
- `--metadata-only`.
- `--output-dir` response files.

## Milestone 5 Progress

- [x] Prompt-run tests written.
- [x] Prompt-run tests fail for the missing run branch.
- [x] Prompt run branch implemented.
- [x] Focused tests pass.
- [x] Typecheck passes.
- [x] Build passes.
- [x] Real CLI smoke run passes.
- [x] Self-contained commit created.

## Current Milestone 6

Implement goal-backed headless runs and graceful pause control.

This milestone shall cover:

- `--goal` creates a goal and prompts with the objective.
- Goal-backed stdout stays metadata-only.
- Goal-backed runs write one Markdown file per completed turn.
- Goal-backed runs write `goal-status.json`.
- Goal-backed status includes `control.path`.
- `pause_goal` calls `pauseGoal()` and does not call `cancel()`.
- Paused goals finish the active turn and end with `state: "paused"`.

## Milestone 6 Progress

- [x] Goal-mode tests written.
- [x] Goal-mode tests fail for missing goal branch.
- [x] Goal-mode run branch implemented.
- [x] Graceful pause control test written.
- [x] Graceful pause control test fails before polling.
- [x] Control polling implemented.
- [x] Focused tests pass.
- [x] Typecheck passes.
- [x] Build passes.
- [x] Real goal CLI smoke run passes with `KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1`.
- [x] Self-contained commit created.

## Later Milestones

- [x] Status, output, output-file, control, and approval helpers.
- [x] SDK session lock helper.
- [x] Headless status and goal-control commands.
- [x] One-turn prompt-backed headless run execution.
- [x] Goal-backed multi-turn execution and file output.
- [ ] Docs and changeset.
- [ ] Build CLI and run manual headless trials.
- [ ] Three example projects under `~/Developer/@kimi-examples/`.
- [ ] Reports with DOs and DONTs.
