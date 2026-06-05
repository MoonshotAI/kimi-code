# Upcoming Goals Queue Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist upcoming goals in a TUI-owned session file without adding queue methods or types to RPC or SDK.

**Architecture:** The TUI reads and writes `<sessionDir>/upcoming-goals.json`. The store uses `Session.summary.sessionDir`, which already exists in the SDK session summary.

**Tech Stack:** TypeScript, Node file I/O, Kimi Code TUI, Vitest.

---

### Task 1: Add The Queue Store

**Files:**

- Create: `apps/kimi-code/src/tui/goal-queue-store.ts`
- Test: `apps/kimi-code/test/tui/goal-queue-store.test.ts`

- [ ] **Step 1: Write store tests**

Cover these cases:

```ts
it('reads an empty queue when the file is missing', async () => {});
it('appends a trimmed upcoming goal and writes the session file', async () => {});
it('updates an upcoming goal objective', async () => {});
it('removes an upcoming goal by id', async () => {});
it('moves an upcoming goal up and down', async () => {});
it('rejects empty and over-long objectives', async () => {});
it('normalizes malformed queue files to an empty queue', async () => {});
it('throws when the session summary does not expose a session directory', async () => {});
```

Expected before implementation: the import from `#/tui/goal-queue-store` fails.

- [ ] **Step 2: Add store types**

Create `apps/kimi-code/src/tui/goal-queue-store.ts`.

Use these exported types:

```ts
export interface UpcomingGoal {
  readonly id: string;
  readonly objective: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GoalQueueSnapshot {
  readonly goals: readonly UpcomingGoal[];
}

export type GoalQueueMoveDirection = 'up' | 'down';
```

Use this private file shape:

```ts
interface GoalQueueFile {
  readonly version: 1;
  readonly goals: readonly UpcomingGoal[];
}
```

- [ ] **Step 3: Resolve the file path from the session**

Use `Session.summary.sessionDir`.

```ts
const GOAL_QUEUE_FILE = 'upcoming-goals.json';

function goalQueuePath(session: Pick<Session, 'id' | 'summary'>): string {
  const sessionDir = session.summary?.sessionDir;
  if (sessionDir === undefined || sessionDir.trim().length === 0) {
    throw new Error(`Session ${session.id} does not expose a session directory`);
  }
  return join(sessionDir, GOAL_QUEUE_FILE);
}
```

Import `Session` from `@moonshot-ai/kimi-code-sdk`.

- [ ] **Step 4: Implement queue operations**

Export these functions:

```ts
export async function readGoalQueue(
  session: Pick<Session, 'id' | 'summary'>,
): Promise<GoalQueueSnapshot>;

export async function appendGoalQueueItem(
  session: Pick<Session, 'id' | 'summary'>,
  input: { readonly objective: string },
): Promise<GoalQueueSnapshot>;

export async function updateGoalQueueItem(
  session: Pick<Session, 'id' | 'summary'>,
  input: { readonly goalId: string; readonly objective: string },
): Promise<GoalQueueSnapshot>;

export async function removeGoalQueueItem(
  session: Pick<Session, 'id' | 'summary'>,
  input: { readonly goalId: string },
): Promise<GoalQueueSnapshot>;

export async function moveGoalQueueItem(
  session: Pick<Session, 'id' | 'summary'>,
  input: { readonly goalId: string; readonly direction: GoalQueueMoveDirection },
): Promise<GoalQueueSnapshot>;
```

Use `randomUUID()` for ids.

Use `mkdir(dirname(file), { recursive: true })` before writes.

- [ ] **Step 5: Validate objectives**

Use the existing public errors from `@moonshot-ai/kimi-code-sdk`:

```ts
ErrorCodes.GOAL_OBJECTIVE_EMPTY
ErrorCodes.GOAL_OBJECTIVE_TOO_LONG
ErrorCodes.GOAL_NOT_FOUND
KimiError
```

Keep the max objective length at 4000.

- [ ] **Step 6: Normalize malformed files**

When the queue file is missing, return:

```ts
{ goals: [] }
```

When the queue file exists but does not match the expected shape, overwrite it with:

```json
{ "version": 1, "goals": [] }
```

- [ ] **Step 7: Run store tests**

Run:

```bash
pnpm --filter @moonshot-ai/kimi-code test apps/kimi-code/test/tui/goal-queue-store.test.ts
```

Expected: all TUI queue store tests pass.

- [ ] **Step 8: Commit this slice**

Use:

```bash
git add apps/kimi-code/src/tui/goal-queue-store.ts apps/kimi-code/test/tui/goal-queue-store.test.ts
git commit -m "feat: add tui upcoming goal queue store"
```
