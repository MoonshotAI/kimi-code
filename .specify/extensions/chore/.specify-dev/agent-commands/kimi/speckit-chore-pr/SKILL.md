---
name: speckit-chore-pr
description: Open a pull request for the implemented chore, linking the tracked issue
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: github-spec-kit
  source: chore:commands/speckit.chore.pr.md
---

# Open Chore Pull Request

Open a GitHub pull request for the chore recorded by
`/skill:speckit-chore-implement`. This command reads
`.specify/chores/<slug>/implement.md` (and `issue.md` if the chore was reported)
and creates a PR via the `gh` CLI from the current branch, linking the issue. If
`gh` or a GitHub remote is unavailable, it writes a ready-to-paste PR draft instead.

> This command is the natural follow-up when `chore.implement` was run with `--branch` / `--worktree`: the current branch is the chore branch (e.g. `chore/<slug>`) and the PR opens from it.

## User Input

```text
$ARGUMENTS
```

Accept any of:

- `slug=<chore-slug>` or `--slug <chore-slug>` or a bare slug-like token.
- A path that contains the slug (e.g. `.specify/chores/logo-swap/`).
- **Nothing** — fall back to context (see Slug Resolution).

## Slug Resolution

Resolve `CHORE_SLUG` in this order, stopping at the first match:

1. **Explicit user input** — a slug passed in `$ARGUMENTS` (any of the forms above).
2. **Conversation context** — if the current session has just run `/skill:speckit-chore-implement` (or `chore.issue`), the slug it reported is the working slug. Reuse it without re-prompting.
3. **Single candidate on disk** — list `.specify/chores/*/implement.md`. If exactly one chore has an `implement.md`, use it.
4. **Disambiguate**:
   - **Interactive mode**: ask the user which chore to open a PR for and list the candidates.
   - **Automated mode**: stop with an error listing the candidates. Do not guess.

Once resolved, set `CHORE_SLUG` and `CHORE_DIR = .specify/chores/<CHORE_SLUG>`.

## Prerequisites

- `CHORE_DIR/implement.md` MUST exist. If it does not, stop and instruct the user to run `/skill:speckit-chore-implement` first.
- Confirm the current branch is the chore branch (created by `chore.implement --branch`, or whatever branch holds the change). If the working tree is on `main`/`master` with uncommitted changes, warn the user and ask which branch to open the PR from before continuing.
- Detect GitHub context (same as `chore.issue`):
  - `git rev-parse --is-inside-work-tree` and `git config --get remote.origin.url` to parse `owner`/`repo`; only proceed live when the remote is `github.com`.
  - `command -v gh` and `gh auth status` to confirm the CLI and auth.
  - If `gh`/GitHub remote/auth is unavailable, write a draft (see Graceful Degradation).

## Execution

1. **Read the records**
   - Read `CHORE_DIR/implement.md` for the summary, changed files, and status.
   - Read `CHORE_DIR/issue.md` (if present) for the issue number/URL to link.

2. **Derive the PR title and body**
   - **Title**: a concise imperative from the implement summary (e.g. `Swap generic logos for giraffe brand`). Prefix with the slug only if it aids traceability (e.g. `[logo-swap] Swap ...`).
   - **Body**: combine the implement **Summary**, the **Changes** table, the **Verification** result, and a link to the assessment: `Assessment: .specify/chores/<CHORE_SLUG>/assessment.md`.
   - If `CHORE_DIR/issue.md` exists, append `Closes #<issue-number>.` (or the full issue URL) so GitHub links and auto-closes the issue on merge.
   - Write the body to `CHORE_DIR/pr-body.md`.

3. **Open the PR (live path)**
   - Determine the base branch: prefer the repository default (usually `main`/`master`); allow the user to override with `base=<branch>` in `$ARGUMENTS`.
   - Run (do **not** use `--json`: older `gh` versions reject it — capture the URL from stdout instead):
     ```bash
     gh pr create --base <base> --title "<title>" --body-file CHORE_DIR/pr-body.md
     ```
   - On success `gh` prints the new PR URL (e.g. `https://github.com/<owner>/<repo>/pull/42`) to stdout. Capture that line and extract the **URL** and the **PR number** (the trailing digits after `/pull/`).
   - If the push of the current branch fails, run `git push -u origin <current-branch>` and retry the `gh pr create`.
   - If `gh`/GitHub remote/auth/network is unavailable, skip to Graceful Degradation below.

4. **Record the PR**
   - Write `CHORE_DIR/pr.md`:
     ```markdown
     # Chore PR: <short title>

     - **Slug**: <CHORE_SLUG>
     - **Opened**: <ISO 8601 date>
     - **PR**: <number>
     - **URL**: <https://github.com/<owner>/<repo>/pull/<number>>
     - **Branch**: <current-branch>
     - **Issue**: <number or "n/a">

     <One-line summary of what the PR contains.>
     ```

5. **Graceful Degradation (no live creation)**
   - When `gh`/GitHub remote/auth is unavailable, write `CHORE_DIR/pr-draft.md` with the title + body and tell the user to open the PR manually (or re-run once authenticated). Do not error.

6. **Report back** with:
   - The slug, the PR URL (or draft path), and the branch it opened from.

## Guardrails

- This command creates an external GitHub PR only — it never edits repository source code beyond pushing the already-applied chore branch.
- It only reads `implement.md`/`issue.md` and writes inside `CHORE_DIR` (`pr.md` / `pr-body.md` / `pr-draft.md`).
- Never claim the issue is closed unless `Closes #<number>` was included and the PR was actually opened.
- Do not force-push or rewrite history; only push the current chore branch with `-u`.