# Upcoming Goals Management Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/goal next manage` so users can browse, reorder, edit, and delete upcoming goals.

**Architecture:** Add a focused dialog component mounted with `mountEditorReplacement`. The dialog calls SDK queue methods and never sends queued objectives to the agent.

**Tech Stack:** TypeScript, `@earendil-works/pi-tui`, Kimi Code TUI dialogs, Vitest.

---

### Task 1: Build The Manager Component

**Files:**

- Create: `apps/kimi-code/src/tui/components/dialogs/goal-queue-manager.ts`
- Create: `apps/kimi-code/test/tui/components/dialogs/goal-queue-manager.test.ts`

- [ ] **Step 1: Write render and key tests**

Cover:

```ts
it('renders queued goals with the standard list header', () => {});
it('renders an empty state with the add command', () => {});
it('moves the cursor with Up and Down', () => {});
it('toggles move mode with Space', () => {});
it('calls onMove while move mode is active', () => {});
it('calls onEdit when E or e is pressed', () => {});
it('calls onDelete when D or d is pressed', () => {});
it('calls onCancel on Escape', () => {});
```

Use `stripAnsi()` like other dialog tests.

- [ ] **Step 2: Add component options**

Use this shape:

```ts
export interface GoalQueueManagerOptions {
  readonly goals: readonly UpcomingGoal[];
  readonly colors: ColorPalette;
  readonly requestRender: () => void;
  readonly onMove: (
    goalId: string,
    direction: GoalQueueMoveDirection,
  ) => Promise<GoalQueueSnapshot>;
  readonly onEdit: (goal: UpcomingGoal) => void;
  readonly onDelete: (goalId: string) => Promise<GoalQueueSnapshot>;
  readonly onCancel: () => void;
}
```

Import `UpcomingGoal`, `GoalQueueMoveDirection`, and `GoalQueueSnapshot` from `#/tui/goal-queue-store`.

- [ ] **Step 3: Follow the TUI dialog design**

Render with:

```text
─────────────────────────────────────────
 Upcoming goals
 ↑↓ navigate · Space move · E edit · D delete · Esc cancel

  ❯ 1. Ship release notes
    2. Update docs

─────────────────────────────────────────
```

When move mode is active, use:

```text
↑↓ reorder · Space done · Esc cancel
```

Use `SELECT_POINTER`, `SearchableList`, `truncateToWidth`, `visibleWidth`, and `printableChar()`.

Use `chalk.hex(colors.<token>)`.

- [ ] **Step 4: Implement move mode**

Behavior:

- Normal Up and Down browse.
- Space toggles move mode for the selected item.
- In move mode, Up calls `onMove(goalId, 'up')`.
- In move mode, Down calls `onMove(goalId, 'down')`.
- After `onMove` resolves, replace the local goals list with `snapshot.goals`.
- Keep focus on the moved goal by id.
- Call `requestRender()` after async updates.

- [ ] **Step 5: Implement delete**

Behavior:

- `D` and `d` delete the focused goal.
- No confirmation dialog in the first version.
- After delete resolves, replace the local list with `snapshot.goals`.
- Clamp the cursor to the new list length.

### Task 2: Build The Edit Dialog

**Files:**

- Modify: `apps/kimi-code/src/tui/components/dialogs/goal-queue-manager.ts`
- Test: `apps/kimi-code/test/tui/components/dialogs/goal-queue-manager.test.ts`

- [ ] **Step 1: Add edit dialog tests**

Cover:

```ts
it('prefills the current objective', () => {});
it('submits a trimmed objective on Enter', () => {});
it('rejects an empty objective', () => {});
it('rejects objectives over 4000 characters', () => {});
it('cancels on Escape', () => {});
```

- [ ] **Step 2: Add `GoalQueueEditDialogComponent`**

Use an `Input` inside a rounded box.

Use:

```ts
this.input.setValue(opts.initialObjective);
this.input.onSubmit = (value) => this.submit(value);
```

Return:

```ts
export type GoalQueueEditResult =
  | { readonly kind: 'ok'; readonly objective: string }
  | { readonly kind: 'cancel' };
```

Use the same max length as `goal.ts`:

```ts
const MAX_GOAL_OBJECTIVE_LENGTH = 4000;
```

### Task 3: Wire `/goal next manage`

**Files:**

- Modify: `apps/kimi-code/src/tui/commands/goal.ts`
- Test: `apps/kimi-code/test/tui/commands/goal.test.ts`

- [ ] **Step 1: Replace the temporary manager response**

Add `showGoalQueueManager(host)` in `goal.ts`.

It should:

```ts
const session = host.requireSession();
const snapshot = await readGoalQueue(session);
host.mountEditorReplacement(
  new GoalQueueManagerComponent({
    goals: snapshot.goals,
    colors: host.state.theme.colors,
    requestRender: () => {
      host.state.ui.requestRender();
    },
    onMove: (goalId, direction) => moveGoalQueueItem(session, { goalId, direction }),
    onDelete: (goalId) => removeGoalQueueItem(session, { goalId }),
    onEdit: (goal) => {
      showGoalQueueEditDialog(host, goal);
    },
    onCancel: () => {
      host.restoreEditor();
    },
  }),
);
```

Callbacks:

- `onMove` calls `moveGoalQueueItem`.
- `onDelete` calls `removeGoalQueueItem`.
- `onEdit` mounts `GoalQueueEditDialogComponent`.
- `onCancel` calls `host.restoreEditor()`.

- [ ] **Step 2: Edit selected goal**

On edit submit:

```ts
const updated = await updateGoalQueueItem(session, {
  goalId: goal.id,
  objective: result.objective,
});
```

Then remount the manager with `updated.goals`.

On edit cancel, remount the manager with the current queue from `readGoalQueue(session)`.

- [ ] **Step 3: Add command tests**

Assert:

```ts
await handleGoalCommand(host, 'next manage');
expect(readGoalQueue).toHaveBeenCalledWith(session);
expect(host.mountEditorReplacement).toHaveBeenCalled();
```

Assert manager actions call the TUI store methods.

- [ ] **Step 4: Run TUI tests**

Run:

```bash
pnpm --filter @moonshot-ai/kimi-code test apps/kimi-code/test/tui/commands/goal.test.ts apps/kimi-code/test/tui/components/dialogs/goal-queue-manager.test.ts
```

Expected: manager command and dialog tests pass.

- [ ] **Step 5: Commit this slice**

Use:

```bash
git add apps/kimi-code/src/tui/commands/goal.ts apps/kimi-code/src/tui/components/dialogs/goal-queue-manager.ts apps/kimi-code/test/tui/commands/goal.test.ts apps/kimi-code/test/tui/components/dialogs/goal-queue-manager.test.ts
git commit -m "feat: manage upcoming goals in the tui"
```
