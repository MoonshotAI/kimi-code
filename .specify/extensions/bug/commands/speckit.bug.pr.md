---
description: "Open a pull request for the applied bug fix, linking the tracked issue"
---

# Open Fix Pull Request

Open a GitHub pull request for the fix recorded by `__SPECKIT_COMMAND_BUG_FIX__`. This command reads `.specify/bugs/<slug>/fix.md` (and `issue.md` if the bug was reported) and creates a PR via the `gh` CLI from the current branch, linking the issue. If `gh` or a GitHub remote is unavailable, it writes a ready-to-paste PR draft instead.

> This command is the natural follow-up when `bug.fix` was run with `--branch` / `--worktree`: the current branch is the fix branch (e.g. `fix/<slug>`) and the PR opens from it.

## User Input

```text
$ARGUMENTS
```

Accept any of:

- `slug=<bug-slug>` or `--slug <bug-slug>` or a bare slug-like token.
- A path that contains the slug (e.g. `.specify/bugs/login-timeout/`).
- **Nothing** — fall back to context (see Slug Resolution).

## Slug Resolution

Resolve `BUG_SLUG` in this order, stopping at the first match:

1. **Explicit user input** — a slug passed in `$ARGUMENTS` (any of the forms above).
2. **Conversation context** — if the current session has just run `__SPECKIT_COMMAND_BUG_FIX__` (or `bug.issue`), the slug it reported is the working slug. Reuse it without re-prompting.
3. **Single candidate on disk** — list `.specify/bugs/*/fix.md`. If exactly one bug has a `fix.md`, use it.
4. **Disambiguate**:
   - **Interactive mode**: ask the user which bug to open a PR for and list the candidates.
   - **Automated mode**: stop with an error listing the candidates. Do not guess.

Once resolved, **normalize and validate** `BUG_SLUG` before constructing `BUG_DIR`:

- Reject absolute paths (starting with `/` or a drive letter).
- Reject any slug containing path separators (`/`, `\`).
- Reject any slug containing traversal segments (`..`, `.`).
- Normalize to lowercase, replace spaces/underscores with hyphens, remove special characters other than `-` and digits.
- After normalization, verify the resolved path `.specify/bugs/<BUG_SLUG>` is strictly under `.specify/bugs/` (no escapes). If validation fails, stop with an error.

Then set `BUG_DIR = .specify/bugs/<BUG_SLUG>`.

## Prerequisites

- `BUG_DIR/fix.md` MUST exist. If it does not, stop and instruct the user to run `__SPECKIT_COMMAND_BUG_FIX__` first.
- Read `BUG_DIR/fix.md` to extract the recorded fix **Branch** field.
- **Compare the recorded branch with the actual current branch**:
  - Run `git rev-parse --abbrev-ref HEAD` to get the current branch.
  - If the recorded branch differs from the current branch, or if the current branch is `main`/`master`/`development` and the working tree is dirty, stop and prompt the user: the PR should open from the fix branch, not from a different branch. Ask whether to switch branches, abort, or proceed anyway (with explicit confirmation).
- Detect GitHub context (same as `bug.issue`):
  - `git rev-parse --is-inside-work-tree` and `git config --get remote.origin.url` to parse `owner`/`repo`; only proceed live when the remote is `github.com`.
  - `command -v gh` and `gh auth status` to confirm the CLI and auth.
  - If `gh`/GitHub remote/auth is unavailable, write a draft (see Graceful Degradation).

## Execution

1. **Read the records**
   - Read `BUG_DIR/fix.md` for the summary, changed files, and status.
   - Read `BUG_DIR/issue.md` (if present) for the issue number/URL to link.

2. **Derive the PR title and body**
   - **Title**: a concise imperative from the fix summary (e.g. `Fix login timeout on OAuth callback`). Prefix with the slug only if it aids traceability (e.g. `[login-timeout] Fix ...`).
   - **Body**: combine the fix **Summary**, the **Changes** table, the **Local Verification** result, and a link to the assessment: `Assessment: .specify/bugs/<BUG_SLUG>/assessment.md`.
   - If `BUG_DIR/issue.md` exists, append `Closes #<issue-number>.` (or the full issue URL) so GitHub links and auto-closes the issue on merge.
   - Write the body to `BUG_DIR/pr-body.md`.

3. **Open the PR (live path)**
   - Determine the base branch: prefer the repository default (usually `main`/`master`); allow the user to override with `base=<branch>` in `$ARGUMENTS`.
   - **Check for an existing remote PR** before creating: if `BUG_DIR/pr.md` already exists, read it for the PR number and verify it still exists with `gh pr view <number>` (or check `gh pr list --head <current-branch>`). If a PR already exists for this branch/issue, report the existing PR URL and skip creation (unless the user explicitly asks to create a new one).
   - Write the title to a temporary file (e.g., `BUG_DIR/pr-title.txt`) so it can be passed safely. Do **not** interpolate the title or base branch directly into the shell command string; pass them as separate argv-safe arguments.
   - Run (do **not** use `--json`: older `gh` versions reject it — capture the URL from stdout instead):
     ```bash
     gh pr create --base <base> --title-file BUG_DIR/pr-title.txt --body-file BUG_DIR/pr-body.md
     ```
   - If `gh pr create` does not support `--title-file`, use `--title` with proper shell quoting: ensure the title and base branch are passed as separate argv elements, not by concatenating into a shell string. For example, invoke `gh` programmatically with an array of arguments, or quote meticulously if building a shell string.
   - On success `gh` prints the new PR URL (e.g. `https://github.com/<owner>/<repo>/pull/42`) to stdout. Capture that line and extract the **URL** and the **PR number** (the trailing digits after `/pull/`).
   - **If creation or recording is ambiguous/fails**, re-check for a duplicate remote PR (`gh pr list --head <current-branch>`) before retrying, to avoid creating duplicates.
   - If the push of the current branch fails, run `git push -u origin <current-branch>` (again, pass `<current-branch>` as a separate argv element) and retry the `gh pr create`.
   - If `gh`/GitHub remote/auth/network is unavailable, skip to Graceful Degradation below.

4. **Record the PR**
   - Write `BUG_DIR/pr.md`:
     ```markdown
     # Bug Fix PR: <short title>

     - **Slug**: <BUG_SLUG>
     - **Opened**: <ISO 8601 date>
     - **PR**: <number>
     - **URL**: <https://github.com/<owner>/<repo>/pull/<number>>
     - **Branch**: <current-branch>
     - **Issue**: <number or "n/a">

     <One-line summary of what the PR contains.>
     ```

5. **Graceful Degradation (no live creation)**
   - When `gh`/GitHub remote/auth is unavailable, write `BUG_DIR/pr-draft.md` with the title + body and tell the user to open the PR manually (or re-run once authenticated). Do not error.

6. **Report back** with:
   - The slug, the PR URL (or draft path), and the branch it opened from.
   - The next suggested step: `__SPECKIT_COMMAND_BUG_TEST__ slug=<BUG_SLUG>` (to validate once the PR is merged or on the branch).

## Guardrails

- This command creates an external GitHub PR only — it never edits repository source code beyond pushing the already-applied fix branch.
- It only reads `fix.md`/`issue.md` and writes inside `BUG_DIR` (`pr.md` / `pr-body.md` / `pr-draft.md`).
- Never claim the issue is closed unless `Closes #<number>` was included and the PR was actually opened.
- Do not force-push or rewrite history; only push the current fix branch with `-u`.
