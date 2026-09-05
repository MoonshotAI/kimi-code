# Changelog

## 1.1.1 - 2026-08-30

- **Fix routing**: gh-triage now explicitly delegates bugs to `bug.fetch` (saved
  under `.specify/bugs/`) and chores to `chore.fetch` (saved under
  `.specify/chores/`). Only features are saved as specs under `specs/` via
  `speckit.specify`. Added explicit guardrails and phase-level instructions to
  prevent accidentally calling `speckit.specify` for bugs or chores.

## 1.1.0 - 2026-08-28

- New `speckit.gh-triage.feature` command: file a GitHub issue describing a new
  feature. The issue is labeled with the configured feature label (default
  `enhancement`); the label is applied only when it already exists in the target
  repo, otherwise it is skipped with a warning (never force-created).
- The `--specify` flag (off by default) makes `feature` automatically run
  `speckit.specify` after creating the issue, turning the request into a spec
  under `specs/`. Without it, the command only files the issue and stops.
- `auto_specify` config key (default `false`): when set to `true` in
  `gh-triage-config.yml`, `feature` runs `speckit.specify` automatically with no
  `--specify` flag needed. `--specify` still forces it on for a single run.
- Engine (`scripts/bash/gh-triage.sh`) gains a `feature` subcommand
  (`gh-triage.sh feature --title ... --body ... [--repo] [--label] [--json]`)
  backed by `gh issue create`; only the deterministic GitHub issue creation
  lives here, keeping the optional spec step in the agent command.

## 1.0.0 - 2026-08-26

- Initial release of `gh-triage`: batch-fetch open GitHub issues, classify each
  as a bug or a feature, label every issue with the configured triage labels
  (opt-out, on by default), and route bugs to the `bug` workflow
  (`bug.fetch` → `bug.assess` → `bug.fix`/`bug.pr`) or features to
  `speckit.specify`.
- Dependency-light engine (`scripts/bash/gh-triage.sh`) uses only `gh` + `jq`.
- Safe by default: assess/labels only; `auto_fix: true` opt-in to run
  `bug.fix` / `bug.pr`.
