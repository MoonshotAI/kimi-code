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
- [ ] Self-contained commit created.

## Later Milestones

- [ ] Status, output, output-file, control, and approval helpers.
- [ ] SDK session lock helper.
- [ ] Headless run execution.
- [ ] Goal-backed multi-turn execution and file output.
- [ ] Headless status command.
- [ ] Docs and changeset.
- [ ] Build CLI and run manual headless trials.
- [ ] Three example projects under `~/Developer/@kimi-examples/`.
- [ ] Reports with DOs and DONTs.
