# Upcoming Goals Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a private, per-session queue of upcoming goals that the TUI can promote after the current goal completes.

**Architecture:** The TUI owns queue persistence in a session-local file. The TUI owns command parsing, the manager dialog, and promotion after completion. RPC and SDK do not expose upcoming-goal methods or types.

**Tech Stack:** TypeScript, Vitest, `@earendil-works/pi-tui`, Kimi Code SDK, agent-core session RPC.

---

## Decisions

- `/goal next <objective>` always queues the objective.
- It queues even when there is no current goal.
- `/goal next manage` opens the manager dialog.
- `<sessionDir>/upcoming-goals.json` stores the queue.
- RPC and SDK do not expose upcoming-goal queue methods or types.
- The agent must not see queued goals in prompt injection, system reminders, tools, or user messages.
- The TUI promotes a queued goal only after a completion event and the follow-up `goal.updated` event with `snapshot: null`.
- The TUI must not promote after pause, cancel, or blocked.
- When blocked and the queue is non-empty, the TUI shows a notice that the next goal starts only after completion.
- The first implementation does not add a queue count badge or queue events.

## Plan Files

- `01-session-queue-store.md` defines the queue file and TUI store.
- `02-tui-queue-store.md` records the RPC and SDK boundary rule.
- `03-goal-next-command.md` adds `/goal next <objective>`.
- `04-completion-promotion.md` promotes queued goals after completion.
- `05-management-dialog.md` adds `/goal next manage`.
- `06-verification-docs-changeset.md` covers final tests, docs, and changeset work.

## Implementation Order

- [ ] Build and test the TUI queue store.
- [ ] Wire commands and event handling to the TUI queue store.
- [ ] Add queue append command parsing and handling.
- [ ] Add completion promotion and blocked notice.
- [ ] Add the management dialog with reorder, edit, and delete.
- [ ] Run focused tests, update docs, and create a changeset.

## Risk Checks

- Promotion must wait for the null clear event. Creating a new goal during the completion event can race with the current goal clear.
- Queue add and manage must work while the agent is streaming.
- Queue objectives must not be appended to the transcript until the queued goal is promoted.
- Create failure during promotion must leave the queued item in place.
