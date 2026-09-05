---
name: speckit-chore-implement
description: Implement the scoped chore (the actual maintenance work) and record what changed
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: github-spec-kit
  source: chore:commands/speckit.chore.implement.md
---

# Implement Chore

Apply the maintenance work that was scoped by `/skill:speckit-chore-assess` and record the changes in an implement report at `.specify/chores/<slug>/implement.md`. This command is **only** valid after an assessment exists for the given slug. Pass `--branch` (or `--worktree`) to isolate the chore on its own git branch before editing, mirroring how `/skill:speckit-specify` isolates feature work.

## User Input

```text
$ARGUMENTS
```

The user input should identify the chore to implement. Accept any of:

- `slug=<chore-slug>` or `--slug <chore-slug>` or just a bare slug-like token.
- A path that contains the slug (e.g. `.specify/chores/logo-swap/`).
- **Branch isolation** (optional): `branch` / `--branch` creates a chore branch (`<prefix>/<slug>`) first; `worktree` / `--worktree` creates a git worktree instead. See **Optional — isolate the chore on a branch** below.
- **Nothing** — fall back to context (see below).

## Slug Resolution

Resolve `CHORE_SLUG` in this order, stopping at the first match:

1. **Explicit user input** — a slug passed in `$ARGUMENTS` (any of the forms above).
2. **Conversation context** — if the current session has just run `/skill:speckit-chore-assess`, the slug it reported is the working slug. Reuse it without re-prompting. Confirm it by checking that `.specify/chores/<slug>/assessment.md` exists; if it does not, fall through.
3. **Single candidate on disk** — list `.specify/chores/*/assessment.md`. If exactly one matching `assessment.md` is found, use the slug from its parent directory.
4. **Disambiguate**:
   - **Interactive mode**: ask the user which chore to implement and list the candidates.
   - **Automated mode**: stop with an error listing the candidates. Do not guess.

Once resolved, set `CHORE_SLUG` and `CHORE_DIR = .specify/chores/<CHORE_SLUG>`, and briefly state in your reply which resolution path was used (explicit / from context / single candidate / asked).

## Prerequisites

- `CHORE_DIR/assessment.md` MUST exist. If it does not, stop and instruct the user to run `/skill:speckit-chore-assess` first.
- If `CHORE_DIR/implement.md` already exists, ask the user whether to overwrite it before continuing (interactive mode) or refuse (automated mode).
- Read `CHORE_DIR/assessment.md` in full. Treat its **Proposed Approach**, **Paths likely to change**, **Verification to run**, **Constitution Check**, and **Risks & Considerations** sections as the contract for this command.

## Execution

1. **Confirm the plan**
   - Restate, in 3–6 bullets, what you are about to change and where, based on the assessment.
   - If the assessment's verdict is `not a chore`, stop — this is the wrong workflow. Tell the user and exit.
   - If the verdict is `needs scoping` and there are unresolved `[NEEDS CLARIFICATION]` items, flag them and ask the user whether to proceed in interactive mode, or stop in automated mode.
   - Re-confirm the **Constitution Check**: the change must still honor `.specify/constitution.md` (if present). If the work would violate a principle, stop and report it.

### Optional — isolate the chore on a branch

By default the chore is applied to the current branch. To match how `/skill:speckit-specify` isolates feature work, you may ask `chore.implement` to create a dedicated branch (or git worktree) first:

- Parse the user input for `branch` / `--branch` / `worktree` / `--worktree` (or `branch=true` / `worktree=true`). These are mutually exclusive; prefer `--branch` unless the user explicitly asks for a worktree.
- Determine the branch name `<prefix>/<CHORE_SLUG>`, where `<prefix>` comes from `.specify/extensions/chore/chore-config.yml` (`branch_prefix`, default `chore`). Example: `chore/logo-swap`. If a branch with that name already exists, stop and ask the user how to proceed (reuse it, choose another name, or skip isolation).
- **Branch mode** (`--branch`): run `git checkout -b <prefix>/<CHORE_SLUG>` from the current branch (assumed clean or committed).
- **Worktree mode** (`--worktree`): run `git worktree add ../<repo>-<CHORE_SLUG> -b <prefix>/<CHORE_SLUG>` so the chore lives in a separate working directory; then continue operations there.
- If Git is unavailable or the directory is not a Git repository, skip isolation with a warning and apply the chore on the current branch.
- State which mode was used in your reply; all subsequent edits happen on that branch/worktree.

2. **Apply the chore**
   - Make the changes described by the preferred approach. Stay within the paths listed by the assessment unless newly discovered evidence requires expanding scope (in which case, log the expansion explicitly in the report).
   - Keep the change minimal — do not refactor unrelated code, do not introduce dependencies that the assessment did not call for, and do not break the constitution's stated constraints.
   - If you discover the assessment was wrong (the approach does not work, the scope is elsewhere), STOP modifying code, document the new finding in the implement report under **Deviations from Assessment**, and recommend re-running `/skill:speckit-chore-assess`.

3. **Run local checks**
   - If the project has obvious verification commands (e.g., `pytest`, `npm test`, `cargo test`, `npm run build`, `lint`), run the ones that exercise the changed paths. Capture pass/fail and key output. For asset swaps, a build + a manual/visual check is the expected verification.
   - Do not run destructive or network-dependent suites without the user's consent.

4. **Write the implement report**

   Write to `CHORE_DIR/implement.md` using this structure:

   ```markdown
   # Chore Implementation: <short title>

   - **Slug**: <CHORE_SLUG>
   - **Implemented**: <ISO 8601 date>
   - **Assessment**: ./assessment.md
   - **Status**: applied | partial | not-applied

   ## Summary

   <One or two sentences describing what was changed and why.>

   ## Changes

   | File | Change | Notes |
   |------|--------|-------|
   | `path/to/file.ts` | <added / modified / removed> | <short note> |
   | `assets/logo.svg` | replaced | <short note> |

   ## Diff Highlights (optional)

   <Short, illustrative snippets of the most important hunks — not a full diff dump.>

   ## Verification

   - Commands run: `<command>` → <result, brief>
   - Manual checks: <what was verified by hand, if anything>

   ## Deviations from Assessment

   <Empty if none. Otherwise, list any places where the actual work departed from the proposed approach and why.>

   ## Follow-ups

   - <suggested cleanup, monitoring, doc update, etc.>
   ```

5. **Report back** with:
   - The slug and `CHORE_DIR/implement.md` path.
   - The status (`applied`, `partial`, `not-applied`).
   - Which branch/worktree the chore was applied to (or "current branch" if isolation was not used).
   - The next suggested step(s), in order:
     - `/skill:speckit-chore-pr slug=<CHORE_SLUG>` (open a PR from the chore branch, linking the issue).

## Guardrails

- Never modify files outside the project workspace.
- Never edit `assessment.md` — it is the contract you are working against. Record disagreements in `implement.md` under **Deviations from Assessment**.
- Never delete files unless the assessment explicitly required it (e.g. a removed asset).
- Never overwrite an existing `implement.md` without confirmation.