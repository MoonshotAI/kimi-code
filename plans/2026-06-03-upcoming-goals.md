# Upcoming Goals Queue Plan

## Goal

Add a private, per-session queue of upcoming goals in the TUI.

The user can queue autonomous tasks that should run after the current goal completes. The agent only sees the active goal. It must not see upcoming goals.

## User Value

We found that agents sometimes complete a goal too quickly. Users can be disappointed that they can assign only one goal at a time.

Many users already know the next independent tasks they want to run. Today they need to wait for the current goal to complete, return to the TUI, and submit the next goal manually.

An upcoming-goals queue lets users prepare several autonomous tasks in one session. The agent still works on one goal at a time, but the TUI can start the next queued goal after the current goal is complete.

This avoids giving the agent a broad combined goal. It also keeps the next tasks hidden until they become the active goal.

## Current Goal Behavior

The current `/goal` command creates one active goal through the session API.

The goal driver keeps running turns while the goal is `active`. The model ends the loop by calling `UpdateGoal`.

The TUI receives `goal.updated` events and can observe when the current goal completes.

## Proposed Commands

Add these TUI commands:

```text
/goal next <objective>
/goal next manage
```

`/goal next <objective>` appends an objective to the upcoming goals queue.

`/goal next manage` opens an interactive management list.

Use `--` to force objective parsing when the objective starts with a reserved word:

```text
/goal next -- manage the release notes
```

## Management List

The management list shows all upcoming goals for the current session.

Expected controls:

- Up and Down browse goals.
- Space enters or exits move mode for the focused goal.
- In move mode, Up and Down reorder the selected goal.
- `e` edits the focused goal.
- `d` removes the focused goal.
- Escape closes the list.

The footer should show the active controls.

Use wording like:

```text
↑↓ browse · Space move · e edit · d delete · Esc close
```

When move mode is active, the footer should make that state clear.

## Queue State

Store the queue per session.

The queue should survive closing and resuming the TUI session.

The agent must not receive the queue in prompt injection, tool output, goal reminders, or normal user messages.

Recommended state shape:

```ts
interface UpcomingGoal {
  id: string;
  objective: string;
  createdAt: string;
  updatedAt: string;
}
```

The queue should live outside `metadata.custom.goal`.

Recommended storage location:

- `<sessionDir>/upcoming-goals.json`

The SDK `SessionSummary` already exposes `sessionDir` to the TUI.

This keeps the queue session-scoped without adding upcoming-goal methods or types to RPC or SDK.

## Promotion Rules

When the active goal completes:

1. The TUI observes the `goal.updated` completion event.
2. The TUI reads the first upcoming goal.
3. The TUI removes that item from the queue.
4. The TUI calls `session.createGoal({ objective })`.
5. The TUI sends the objective as normal user input.

Do not promote the next goal when the current goal becomes `paused`.

Do not promote the next goal when the current goal is cancelled.

Do not promote the next goal when the current goal becomes `blocked`.

When the current goal is blocked and the queue is non-empty, show a TUI notice:

```text
Goal blocked. The next queued goal will start only after this goal is complete.
```

## No Current Goal

Decision: `/goal next <objective>` queues the goal even when there is no active, paused, or blocked current goal.

This keeps `/goal next` literal and avoids surprising automatic starts.

## Architecture

Keep the feature TUI-owned.

The TUI should provide persistence and small queue operations. It should not add upcoming goals to agent-core RPC, the node SDK, prompt injection, or agent context.

Suggested split:

- `apps/kimi-code/src/tui/goal-queue-store.ts`
  - Owns queue state validation, queue operations, and file persistence.
  - Stores queue state inside the current session directory.
- `apps/kimi-code/src/tui/commands/goal.ts`
  - Parses `/goal next`.
  - Adds the queue append and manage entry points.
- `apps/kimi-code/src/tui/components/dialogs/goal-queue-manager.ts`
  - Implements the interactive management list.
- `apps/kimi-code/src/tui/controllers/session-event-handler.ts`
  - Promotes the next queued goal after completion.
  - Shows the blocked notice when needed.

## UI Placement

The management list should be a dialog component mounted with `mountEditorReplacement`.

Follow the existing selector and dialog patterns in `apps/kimi-code/src/tui/components/dialogs/`.

Use theme tokens from `ColorPalette`. Do not use chalk named colors.

## Event Flow

Completion flow:

```text
goal.updated(completion)
  -> TUI renders completion message
  -> TUI checks upcoming queue
  -> TUI starts next goal if one exists
  -> TUI sends next objective as normal input
```

Blocked flow:

```text
goal.updated(lifecycle, blocked)
  -> TUI renders blocked marker
  -> TUI checks upcoming queue
  -> TUI shows notice if queue is non-empty
```

Paused and cancelled flow:

```text
goal.updated(paused or null)
  -> TUI does not start a queued goal
```

## Tests

Add or update tests in the nearest existing test files.

Recommended coverage:

- `/goal next <objective>` parses as queue append.
- `/goal next manage` opens the manager.
- `--` lets users queue objectives that start with reserved words.
- The queue persists in session metadata.
- Resuming a session restores the queue.
- Completion promotes the next goal and sends the next objective as normal input.
- Blocked goals do not promote the next item.
- Paused goals do not promote the next item.
- Cancelled goals do not promote the next item.
- The management list can browse, move, edit, and delete entries.

## Deferred Choices

- Should there be a footer badge that shows the upcoming goal count?
- Should deleting an item ask for confirmation after the first version?
- Should the queue emit a live `goal.queue.updated` event for non-TUI clients?

## Suggested First Implementation Slice

Build the feature in this order:

1. Add TUI-owned session-level queue persistence.
2. Add `/goal next <objective>` and queue status display.
3. Promote the next queued goal only after completion.
4. Add blocked notice.
5. Add `/goal next manage`.
6. Add reorder, edit, and delete behavior in the manager.

This keeps each slice testable and avoids mixing persistence, promotion, and interactive editing in one change.

## Detailed Implementation Plan

Use these files for the implementation-level plan:

- `plans/upcoming-goals/00-index.md`
- `plans/upcoming-goals/01-session-queue-store.md`
- `plans/upcoming-goals/02-tui-queue-store.md`
- `plans/upcoming-goals/03-goal-next-command.md`
- `plans/upcoming-goals/04-completion-promotion.md`
- `plans/upcoming-goals/05-management-dialog.md`
- `plans/upcoming-goals/06-verification-docs-changeset.md`
