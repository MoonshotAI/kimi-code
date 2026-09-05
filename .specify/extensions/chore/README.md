# Chore Workflow Extension

A maintenance-chore workflow for Spec Kit: scope, track, implement, and report
non-feature, non-bug work — all constitution-aware and recorded under
`.specify/chores/<slug>/`.

## What is a chore?

A **chore** is work that is neither a bug (something broken) nor a feature (new
user-facing capability): refactors, dependency bumps, asset/branding swaps,
config cleanups, tooling changes, and similar maintenance. The `chore` extension
gives this work the same Spec Kit treatment as features and bugs — it is scoped,
tracked, and recorded — but classified on its own so triage and reporting stay
honest.

Crucially, chores stay **inside the Spec Kit ecosystem and aware of the project
constitution**: `chore.assess` consults `.specify/constitution.md` and refuses
approaches that would violate its stated principles.

## Overview

1. **Assess** — read a chore description (pasted text or a URL), consult the
   constitution, locate affected paths, judge scope/risk, and propose an approach.
   `assess` writes a *local* assessment only; it does **not** file a GitHub issue.
2. **Load** (alternative entry point) — `speckit.chore.fetch` pulls an *existing*
   GitHub issue (by number, URL, or `owner/repo#n`) via `gh`, records it as
   `issue.md`, and seeds an `assessment.md` draft. Use this when the chore is
   already tracked on GitHub and you want to scope and implement it here.
3. **Report** (optional) — `speckit.chore.issue` turns an assessment into a
   tracked GitHub issue via `gh`, recording the issue link. `assess` can
   auto-trigger this with `--issue` or the `auto_create_issue` config.
4. **Implement** — apply the scoped chore (the actual maintenance work) and record
   exactly what changed. Pass `--branch` (or `--worktree`) to isolate the chore on
   its own git branch.
5. **Open PR** (optional) — `speckit.chore.pr` opens a pull request from the chore
   branch, linking the issue.

The stages communicate through Markdown files in a single per-chore directory:

```
.specify/chores/<slug>/
├── assessment.md    # written by speckit.chore.assess
├── issue.md         # written by speckit.chore.issue or speckit.chore.fetch (issue number + URL)
├── issue-body.md    # issue body draft used by speckit.chore.issue
├── issue-draft.md   # fallback when gh/GitHub is unavailable
├── implement.md     # written by speckit.chore.implement
├── pr.md            # written by speckit.chore.pr (PR number + URL)
├── pr-body.md       # PR body draft used by speckit.chore.pr
└── pr-draft.md      # fallback when gh/GitHub is unavailable
```

## Commands

| Command | Description | Output |
|---------|-------------|--------|
| `speckit.chore.assess` | Scope a chore against the codebase and constitution. | `.specify/chores/<slug>/assessment.md` |
| `speckit.chore.issue` | Files a GitHub issue from the assessment (the "report" phase). | `.specify/chores/<slug>/issue.md` |
| `speckit.chore.fetch` | Loads an existing GitHub issue (`issue.md`) and seeds a triage draft. | `.specify/chores/<slug>/issue.md` + `assessment.md` |
| `speckit.chore.implement` | Applies the scoped chore (`--branch`/`--worktree` to isolate). | `.specify/chores/<slug>/implement.md` |
| `speckit.chore.pr` | Opens a PR for the chore, linking the issue. | `.specify/chores/<slug>/pr.md` |

## Slug Conventions

A *slug* is the per-chore directory name under `.specify/chores/`. It is the only
handle the commands share.

- **User-provided**: any shape the user wants, normalized to lowercase kebab-case
  (e.g. `logo-swap`, `bump-flutter-3`). The slug is preserved verbatim after
  normalization — no timestamps or numbers are appended automatically.
- **Asked for**: in interactive use, `speckit.chore.assess` asks for a slug when
  none is supplied, suggesting a kebab-case default derived from the chore summary.
- **Automated**: when no human is available to answer, the agent generates a slug
  itself. The generated slug **MUST** produce a unique directory — if
  `.specify/chores/<slug>/` already exists, the agent appends the shortest
  disambiguating suffix needed (`-2`, `-3`, …) or a short date (`-20260605`).
  Existing chore directories are never overwritten.

## Integration with gh-triage

The [`gh-triage`](../gh-triage) extension classifies open issues as `bug`,
`feature`, `chore`, or `unknown`. Chores are loaded and assessed by default
(`chore.fetch` + `chore.assess`); `gh-triage` never implements a chore or opens a
PR unless its `auto_implement` config is `true`.

## Installation

```bash
# Install from a checked-out copy (no network required)
specify extension add --dev <path-to-speckit-extensions>/chore
```

## Configuration

The extension reads `.specify/extensions/chore/chore-config.yml` (copied from
`config-template.yml` on install). Options:

- `auto_create_issue` (`false`) — when `true`, `speckit.chore.assess` files the
  GitHub issue automatically after writing the assessment. The `--issue` flag
  overrides this per run. Keep `false` when driving chores through `gh-triage`
  (it loads issues that already exist, so an extra issue would be a duplicate).
- `branch_prefix` (`"chore"`) — prefix for the chore branch created by
  `speckit.chore.implement --branch` / `--worktree` (branch is `<prefix>/<slug>`,
  e.g. `chore/logo-swap`).
- `default_host` (`"github"`) — Git host used when creating issues/PRs.

## Guardrails

- `speckit.chore.assess` and `speckit.chore.fetch` **never modify source code**.
  They read the repository and write only inside `.specify/chores/<slug>/`.
- `speckit.chore.issue` and `speckit.chore.pr` are opt-in **external** actions
  (they call the `gh` CLI). They never edit repository source; when `gh`/GitHub is
  unavailable they write a local draft (`issue-draft.md` / `pr-draft.md`) instead
  of erroring.
- `speckit.chore.implement` is the only command that edits source code, and it
  stays within the paths listed in the assessment unless new evidence requires
  expanding scope (which is logged in `implement.md` under **Deviations from
  Assessment**).
- None of the commands overwrite an existing report file without explicit
  confirmation; in automated mode they refuse and pick a new unique slug instead.
- `chore.assess` refuses work that would violate the project constitution and
  records the conflict under **Constitution Check**.

## Hooks

This extension registers no hooks. The commands are always invoked explicitly by the user (or routed by `gh-triage`).
