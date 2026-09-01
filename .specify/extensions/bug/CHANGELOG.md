# Changelog

## 1.1.0 - 2026-08-28

- Added a `tdd_enabled` config flag (default `true`). When on, `bug.fix` and `bug.test`
  run through the TDD extension's red-green-refactor loop instead of ad-hoc testing:
  `bug.fix` synthesizes `spec.md` from the assessment, pins the bug directory as the TDD
  feature, and drives `tdd.setup` → `tdd.plan` → `tdd.run` → `implement`; `bug.test`
  runs `tdd.verify` and reports its verdict. This mirrors `spec-whole` for bugs.
- Declared a `requires.commands` dependency on the TDD extension
  (`speckit.tdd.setup`, `speckit.tdd.plan`, `speckit.tdd.run`, `speckit.tdd.verify`) so
  installing `bug` also pulls in `tdd` when `tdd_enabled` is used.
- The classic fix → test → PR flow is preserved when `tdd_enabled: false`.

## 1.0.0 - 2026-08-26

- Initial release of `bug` (copied from `github/spec-kit`): assess, issue, fetch, fix,
  pr, and test commands for an end-to-end bug triage workflow with per-bug reports under
  `.specify/bugs/<slug>/`.
