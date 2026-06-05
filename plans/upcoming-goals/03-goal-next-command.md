# Goal Next Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/goal next <objective>` so users can queue work while the current goal is running.

**Architecture:** Extend the existing `/goal` parser and handler. Queueing writes session metadata through the SDK and does not send a user message to the agent.

**Tech Stack:** TypeScript, Kimi Code TUI slash commands, Vitest.

---

### Task 1: Parse `/goal next`

**Files:**

- Modify: `apps/kimi-code/src/tui/commands/goal.ts`
- Modify: `apps/kimi-code/src/tui/commands/registry.ts`
- Test: `apps/kimi-code/test/tui/commands/goal.test.ts`
- Test: `apps/kimi-code/test/tui/commands/registry.test.ts`

- [ ] **Step 1: Add parser tests**

Add these assertions to `parseGoalCommand` tests:

```ts
expect(parseGoalCommand('next Ship release notes')).toEqual({
  kind: 'next-add',
  objective: 'Ship release notes',
});

expect(parseGoalCommand('next manage')).toEqual({ kind: 'next-manage' });

expect(parseGoalCommand('next -- manage release notes')).toEqual({
  kind: 'next-add',
  objective: 'manage release notes',
});

expect(parseGoalCommand('next')).toEqual({
  kind: 'error',
  severity: 'hint',
  message:
    'Provide an upcoming goal objective, e.g. `/goal next Ship feature X`, or use `/goal next manage`.',
});
```

- [ ] **Step 2: Extend the parsed command union**

Add:

```ts
| { readonly kind: 'next-add'; readonly objective: string }
| { readonly kind: 'next-manage' }
```

- [ ] **Step 3: Parse `next` before `replace`**

In `parseGoalCommand`, handle `tokens[0] === 'next'` before the existing `replace` parsing.

Rules:

- `next manage` maps to `next-manage`.
- `next -- manage` queues an objective that starts with `manage`.
- `next <objective>` queues the objective.
- Empty `next` returns a hint.
- The same 4000-character limit applies.

- [ ] **Step 4: Add autocomplete and availability**

Add `next` to `GOAL_ARG_COMPLETIONS`:

```ts
{ value: 'next', description: 'Queue an upcoming goal' },
```

In `/goal` availability, make `next` and any argument string that starts with `next ` available while streaming:

```ts
if (trimmed === 'next' || trimmed.startsWith('next ')) return 'always';
```

Keep `resume`, `replace`, and direct goal creation as idle-only.

### Task 2: Queue The Objective

**Files:**

- Modify: `apps/kimi-code/src/tui/commands/goal.ts`
- Test: `apps/kimi-code/test/tui/commands/goal.test.ts`

- [ ] **Step 1: Mock the TUI queue store**

In `apps/kimi-code/test/tui/commands/goal.test.ts`, mock:

```ts
vi.mock('#/tui/goal-queue-store', () => ({
  appendGoalQueueItem: vi.fn(async () => ({
    goals: [{ id: 'q1', objective: 'obj', createdAt: '', updatedAt: '' }],
  })),
}));
```

- [ ] **Step 2: Add command handler tests**

Add tests for:

```ts
await handleGoalCommand(host, 'next Ship release notes');
expect(appendGoalQueueItem).toHaveBeenCalledWith(session, {
  objective: 'Ship release notes',
});
expect(host.sendNormalUserInput).not.toHaveBeenCalled();
expect(host.showStatus).toHaveBeenCalledWith(
  'Upcoming goal added. It will start after the current goal is complete.',
);
```

Also test that queueing does not require a configured model.

- [ ] **Step 3: Implement `queueNextGoal`**

Add a helper in `goal.ts`:

```ts
async function queueNextGoal(
  host: SlashCommandHost,
  parsed: Extract<ParsedGoalCommand, { kind: 'next-add' }>,
): Promise<void> {
  try {
    await appendGoalQueueItem(host.requireSession(), { objective: parsed.objective });
  } catch (error) {
    host.showError(formatErrorMessage(error));
    return;
  }
  host.track('goal_queue_append');
  host.showStatus('Upcoming goal added. It will start after the current goal is complete.');
}
```

Import `appendGoalQueueItem` from `#/tui/goal-queue-store`.

Do not call `sendNormalUserInput`.

- [ ] **Step 4: Add a temporary manager response**

Until the manager dialog is added, route `next-manage` to a small status message:

```ts
host.showStatus('Upcoming goal manager is not available yet.');
```

The management-dialog slice will replace this with the real dialog.

- [ ] **Step 5: Run command tests**

Run:

```bash
pnpm --filter @moonshot-ai/kimi-code test apps/kimi-code/test/tui/commands/goal.test.ts apps/kimi-code/test/tui/commands/registry.test.ts
```

Expected: parsing, availability, and queue append tests pass.

- [ ] **Step 6: Commit this slice**

Use:

```bash
git add apps/kimi-code/src/tui/commands/goal.ts apps/kimi-code/src/tui/commands/registry.ts apps/kimi-code/test/tui/commands/goal.test.ts apps/kimi-code/test/tui/commands/registry.test.ts
git commit -m "feat: add goal next queue command"
```
