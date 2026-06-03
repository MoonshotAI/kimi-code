# Upcoming Goals RPC And SDK Boundary Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep upcoming-goal queue data out of RPC and SDK.

**Architecture:** The feature uses only the TUI store from `apps/kimi-code/src/tui/goal-queue-store.ts`. RPC and SDK continue to expose only the current goal lifecycle.

**Tech Stack:** TypeScript, `rg`, Kimi Code TUI.

---

### Task 1: Confirm The Current Boundary

**Files:**

- Read: `packages/agent-core/src/rpc/core-api.ts`
- Read: `packages/agent-core/src/session/rpc.ts`
- Read: `packages/node-sdk/src/session.ts`
- Read: `packages/node-sdk/src/types.ts`

- [ ] **Step 1: Search RPC and SDK for queue symbols**

Run:

```bash
rg -n "GoalQueue|UpcomingGoal|goalQueue|appendGoalQueue|getGoalQueue|moveGoalQueue|removeGoalQueue|updateGoalQueue" packages/agent-core packages/node-sdk
```

Expected: no matches in source files.

- [ ] **Step 2: Keep current goal methods unchanged**

Do not change these existing methods:

```ts
createGoal
getGoal
pauseGoal
resumeGoal
cancelGoal
```

They are for the active goal only.

### Task 2: Avoid New RPC Or SDK Types

**Files:**

- Do not modify: `packages/agent-core/src/rpc/core-api.ts`
- Do not modify: `packages/agent-core/src/rpc/core-impl.ts`
- Do not modify: `packages/agent-core/src/session/rpc.ts`
- Do not modify: `packages/agent-core/src/rpc/events.ts`
- Do not modify: `packages/node-sdk/src/session.ts`
- Do not modify: `packages/node-sdk/src/rpc.ts`
- Do not modify: `packages/node-sdk/src/types.ts`
- Do not modify: `packages/node-sdk/src/events.ts`

- [ ] **Step 1: Use TUI imports only**

When command, event handler, or dialog code needs the queue, import from:

```ts
import {
  appendGoalQueueItem,
  moveGoalQueueItem,
  readGoalQueue,
  removeGoalQueueItem,
  updateGoalQueueItem,
  type GoalQueueMoveDirection,
  type GoalQueueSnapshot,
  type UpcomingGoal,
} from '#/tui/goal-queue-store';
```

- [ ] **Step 2: Add a final boundary check**

After implementation, run the same `rg` command from Task 1.

Expected: no matches in `packages/agent-core` or `packages/node-sdk`.

- [ ] **Step 3: Commit no source changes for this slice**

This slice is a boundary rule and verification step.

Do not create a commit unless you had to remove accidental RPC or SDK changes.
