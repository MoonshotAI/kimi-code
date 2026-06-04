# Upcoming Goals Verification And Release Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify the upcoming goals feature, update user docs, and add the release metadata.

**Architecture:** Run focused tests first, then broader package tests. Update docs because the slash command behavior changes. Add a changeset for the CLI package.

**Tech Stack:** pnpm, Vitest, VitePress docs, changesets.

---

### Task 1: Run Focused Verification

**Files:**

- Read: changed source and test files from the previous slices.

- [ ] **Step 1: Run TUI queue store tests**

Run:

```bash
pnpm --filter @moonshot-ai/kimi-code test apps/kimi-code/test/tui/goal-queue-store.test.ts
```

Expected: all queue store tests pass.

- [ ] **Step 2: Run TUI command tests**

Run:

```bash
pnpm --filter @moonshot-ai/kimi-code test apps/kimi-code/test/tui/commands/goal.test.ts apps/kimi-code/test/tui/commands/registry.test.ts
```

Expected: `/goal next` parsing, queueing, and availability tests pass.

- [ ] **Step 3: Run TUI dialog and event tests**

Run:

```bash
pnpm --filter @moonshot-ai/kimi-code test apps/kimi-code/test/tui/components/dialogs/goal-queue-manager.test.ts apps/kimi-code/test/tui/controllers/session-event-handler-goal-queue.test.ts
```

Expected: manager and promotion tests pass.

- [ ] **Step 4: Verify RPC and SDK stay clean**

Run:

```bash
rg -n "GoalQueue|UpcomingGoal|goalQueue|appendGoalQueue|getGoalQueue|moveGoalQueue|removeGoalQueue|updateGoalQueue" packages/agent-core packages/node-sdk
```

Expected: no matches.

### Task 2: Run Package Verification

**Files:**

- Read: `package.json`
- Read: package `package.json` files for changed packages.

- [ ] **Step 1: Run changed package tests**

Run:

```bash
pnpm --filter @moonshot-ai/kimi-code test
```

Expected: all changed package tests pass.

- [ ] **Step 2: Run root checks if package tests expose cross-package issues**

Run:

```bash
pnpm test
```

Expected: root Vitest suite passes.

### Task 3: Update User Docs

**Files:**

- Modify: docs pages that list slash commands and goal behavior.
- Read: `docs/AGENTS.md`
- Use skill: `.agents/skills/gen-docs/SKILL.md`

- [ ] **Step 1: Use the docs skill**

Run the `gen-docs` skill after the implementation diff exists.

Update the English and Chinese docs that describe `/goal`.

The docs should cover:

- `/goal next <objective>` queues an upcoming goal.
- `/goal next manage` opens the manager.
- Queued goals start only after the current goal completes.
- Queued goals do not start after pause, cancel, or blocked.
- `--` lets an objective start with `manage`.

- [ ] **Step 2: Keep docs user-focused**

Use wording like:

```text
Use `/goal next <objective>` to queue another goal for the same session.
Kimi Code starts it after the current goal completes.
Use `/goal next manage` to reorder, edit, or remove queued goals.
```

Do not describe internal metadata keys in user docs.

### Task 4: Add A Changeset

**Files:**

- Create: `.changeset/<short-name>.md`
- Use skill: `.agents/skills/gen-changesets/SKILL.md`

- [ ] **Step 1: Use the changeset skill**

Run the `gen-changesets` skill after all source changes are in place.

This feature is a backwards-compatible user-facing CLI feature, so the likely bump is `minor`.

The changed package should be:

```markdown
"@moonshot-ai/kimi-code": minor
```

Use this changelog style:

```markdown
Add an upcoming goals queue for autonomous goal work in the TUI.
```

- [ ] **Step 2: Commit docs and changeset**

Use:

```bash
git add docs .changeset
git commit -m "docs: document upcoming goal queue"
```

### Task 5: Final Diff Review

**Files:**

- Read: `git diff --stat`
- Read: `git diff`

- [ ] **Step 1: Check privacy boundaries**

Confirm:

- queued objectives are not added to agent context until promotion
- queued objectives are not included in goal prompt injection
- queued objectives are not written as user transcript messages until promotion
- blocked, paused, and cancelled do not promote

- [ ] **Step 2: Check plain command behavior**

Confirm:

- `/goal next <objective>` works while streaming
- `/goal next manage` opens the dialog
- `e` edits the selected goal
- `d` deletes the selected goal
- Space toggles move mode
- Up and Down reorder only while move mode is active

- [ ] **Step 3: Commit final fixes**

Use focused commits for any fixes found during review.
