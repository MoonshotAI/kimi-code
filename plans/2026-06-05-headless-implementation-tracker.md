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

## Current Milestone 7

Wire fail-safe plan approval flags.

This milestone shall cover:

- Plan approval handler for `ExitPlanMode` and `plan_review`.
- `--approve-plan` approves plan review.
- `--reject-plan` rejects and exits plan mode.
- Missing plan flag cancels plan review in headless mode.
- Unused plan flags become non-fatal warnings.
- Warnings appear in metadata and status files.

## Milestone 7 Progress

- [x] Approval helper tests written.
- [x] Run-level unused warning test written.
- [x] Approval handler implemented.
- [x] Run-level warnings implemented.
- [x] Focused tests pass.
- [x] Typecheck passes.
- [x] Build passes.
- [x] Real `--approve-plan` unused-warning smoke run passes.
- [x] Self-contained commit created.

## Current Milestone 8

Document headless mode and add the changeset.

This milestone shall cover:

- English command reference.
- Chinese command reference.
- Changeset for the CLI, SDK, and agent-core package changes.
- Plan correction for graceful goal pause semantics.

## Milestone 8 Progress

- [x] English command reference updated.
- [x] Chinese command reference updated.
- [x] Graceful pause plan wording amended.
- [x] Changeset written.
- [x] Focused tests pass.
- [x] Typecheck passes.
- [x] Build passes.
- [x] Docs build passes with the repo pnpm environment.
- [ ] Self-contained commit created.

## Current Milestone 9

Run manual headless trials and example projects.

This milestone shall cover:

- Built CLI smoke checks after the final code commit.
- Three side projects under `/tmp/kimi-headless-examples/`.
- At least 10 headless turns per side project.
- Status file polling and metadata/file output during the trials.
- Reports with DOs and DONTs from the trial runs.

## Milestone 9 Progress

- [x] Built CLI smoke checks pass.
- [x] Example project 1 reaches at least 10 turns: `headless-js-checklist`, 11 completed turns.
- [x] Example project 2 reaches at least 10 turns: `headless-python-textstats`, 10 completed turns and one pre-fix interrupted turn.
- [x] Example project 3 reaches at least 10 turns: `headless-web-timer`, 11 completed turns.
- [x] Reports written.
- [x] Self-contained commit created if repository files change.

## Later Milestones

- [x] Status, output, output-file, control, and approval helpers.
- [x] SDK session lock helper.
- [x] Headless status and goal-control commands.
- [x] One-turn prompt-backed headless run execution.
- [x] Goal-backed multi-turn execution and file output.
- [x] Fail-safe plan approval flags.
- [x] Docs and changeset.
- [x] Build CLI and run manual headless trials.
- [x] Three example projects under `/tmp/kimi-headless-examples/`.
- [x] Reports with DOs and DONTs.
