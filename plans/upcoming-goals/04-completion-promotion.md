# Upcoming Goals Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start the next queued goal only after the current goal completes and clears.

**Architecture:** The session event handler observes goal lifecycle events. It marks completion as pending, waits for the follow-up null snapshot, then starts the first queued goal.

**Tech Stack:** TypeScript, Kimi Code TUI event handling, Kimi Code SDK, Vitest.

---

### Task 1: Promote After The Clear Event

**Files:**

- Modify: `apps/kimi-code/src/tui/controllers/session-event-handler.ts`
- Create: `apps/kimi-code/test/tui/controllers/session-event-handler-goal-queue.test.ts`

- [ ] **Step 1: Write the promotion event test**

Create a host with:

```ts
const session = {
  createGoal: vi.fn(async () => fakeGoalSnapshot('Ship queued goal')),
};
```

Mock the TUI queue store:

```ts
vi.mock('#/tui/goal-queue-store', () => ({
  readGoalQueue: vi.fn(async () => ({
    goals: [{ id: 'q1', objective: 'Ship queued goal', createdAt: '', updatedAt: '' }],
  })),
  removeGoalQueueItem: vi.fn(async () => ({ goals: [] })),
}));
```

Call `handler.handleEvent()` twice:

```ts
handler.handleEvent(goalCompletionEvent, vi.fn());
handler.handleEvent(goalClearedEvent, vi.fn());
```

Assert:

```ts
await vi.waitFor(() => {
  expect(session.createGoal).toHaveBeenCalledWith({ objective: 'Ship queued goal' });
});
expect(removeGoalQueueItem).toHaveBeenCalledWith(session, { goalId: 'q1' });
expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship queued goal');
```

Expected before implementation: the test fails because no promotion runs.

- [ ] **Step 2: Track completion awaiting clear**

Add a private field:

```ts
private goalCompletionAwaitingClear = false;
```

In the completion branch of `handleGoalUpdated`, set it before returning:

```ts
this.goalCompletionAwaitingClear = true;
```

- [ ] **Step 3: Promote only on `snapshot: null`**

At the start of `handleGoalUpdated`, after `setAppState`, add:

```ts
if (event.snapshot === null && this.goalCompletionAwaitingClear) {
  this.goalCompletionAwaitingClear = false;
  void this.promoteNextQueuedGoal();
}
```

This avoids racing with `SessionGoalStore.markComplete()`, which emits completion before it clears the durable goal.

- [ ] **Step 4: Implement `promoteNextQueuedGoal`**

Add a private async method:

```ts
private async promoteNextQueuedGoal(): Promise<void> {
  const session = this.host.session;
  if (session === undefined || this.host.aborted) return;

  let next;
  try {
    const queue = await readGoalQueue(session);
    next = queue.goals[0];
  } catch (error) {
    this.host.showError(`Failed to read upcoming goals: ${formatErrorMessage(error)}`);
    return;
  }
  if (next === undefined) return;

  try {
    await session.createGoal({ objective: next.objective });
  } catch (error) {
    this.host.showError(`Failed to start queued goal: ${formatErrorMessage(error)}`);
    return;
  }

  try {
    await removeGoalQueueItem(session, { goalId: next.id });
  } catch (error) {
    this.host.showError(`Queued goal started, but could not be removed from the queue: ${formatErrorMessage(error)}`);
  }

  this.host.state.transcriptContainer.addChild(
    new GoalSetMessageComponent(this.host.state.theme.colors),
  );
  this.host.state.ui.requestRender();
  this.host.sendNormalUserInput(next.objective);
}
```

Import `GoalSetMessageComponent` from `../components/messages/goal-panel`.

Import `formatErrorMessage` from `../utils/event-payload` if the file does not already import it.

Import `readGoalQueue` and `removeGoalQueueItem` from `#/tui/goal-queue-store`.

- [ ] **Step 5: Keep create failures non-destructive**

Add a test where `session.createGoal` rejects.

Assert:

```ts
expect(removeGoalQueueItem).not.toHaveBeenCalled();
expect(host.sendNormalUserInput).not.toHaveBeenCalled();
expect(host.showError).toHaveBeenCalled();
```

This ensures the queued goal stays in the queue when it cannot start.

### Task 2: Do Not Promote On Blocked, Paused, Or Cancelled

**Files:**

- Modify: `apps/kimi-code/src/tui/controllers/session-event-handler.ts`
- Test: `apps/kimi-code/test/tui/controllers/session-event-handler-goal-queue.test.ts`

- [ ] **Step 1: Add blocked notice test**

Use a blocked lifecycle event:

```ts
const event = {
  type: 'goal.updated',
  sessionId: 's1',
  agentId: 'main',
  snapshot: { ...fakeGoalSnapshot('Blocked'), status: 'blocked' },
  change: { kind: 'lifecycle', status: 'blocked', reason: 'waiting for access' },
} as const;
```

Assert:

```ts
await vi.waitFor(() => {
  expect(host.showNotice).toHaveBeenCalledWith(
    'Goal blocked.',
    'The next queued goal will start only after this goal is complete.',
  );
});
expect(session.createGoal).not.toHaveBeenCalled();
```

- [ ] **Step 2: Implement blocked notice**

In `handleGoalUpdated`, when `change.kind === 'lifecycle' && change.status === 'blocked'`, call:

```ts
void this.notifyQueuedGoalWaitingOnBlocked();
```

Add:

```ts
private async notifyQueuedGoalWaitingOnBlocked(): Promise<void> {
  const session = this.host.session;
  if (session === undefined || this.host.aborted) return;
  try {
    const queue = await readGoalQueue(session);
    if (queue.goals.length === 0) return;
  } catch {
    return;
  }
  this.host.showNotice(
    'Goal blocked.',
    'The next queued goal will start only after this goal is complete.',
  );
}
```

- [ ] **Step 3: Add paused and cancelled tests**

Add tests that send:

- a lifecycle event with `status: 'paused'`
- a clear event with `snapshot: null` and no prior completion

Assert `createGoal` is not called.

- [ ] **Step 4: Run event handler tests**

Run:

```bash
pnpm --filter @moonshot-ai/kimi-code test apps/kimi-code/test/tui/controllers/session-event-handler-goal-queue.test.ts
```

Expected: promotion, blocked notice, paused, and cancelled tests pass.

- [ ] **Step 5: Commit this slice**

Use:

```bash
git add apps/kimi-code/src/tui/controllers/session-event-handler.ts apps/kimi-code/test/tui/controllers/session-event-handler-goal-queue.test.ts
git commit -m "feat: promote queued goals after completion"
```
