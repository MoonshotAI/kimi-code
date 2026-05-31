# Phase 8: Goal state consolidation

Collapse the goal lifecycle to the minimal, unambiguous set validated against Codex's
`/goal` behavior. Approved design (see the discussion in session history):

## Target state machine

| Status     | Persisted | Resumable | Box            | Meaning                                                            |
|------------|-----------|-----------|----------------|-------------------------------------------------------------------|
| `active`   | yes       | (running) | "Pursuing goal"| Continuation loop drives work; full injection.                    |
| `paused`   | yes       | yes       | shown          | User stopped it (`/goal pause`) or a turn was interrupted (Esc).  |
| `blocked`  | yes       | **yes**   | "Goal blocked" | System stopped it — *any* reason, carried as `reason` text.       |
| `complete` | **no**    | —         | disappears     | Success → append a guaranteed completion message, then clear.     |

- Durable record only ever holds `active` / `paused` / `blocked`.
- `complete` is transient (announce-then-clear), so the box disappears — like the old
  `cancelled` pattern but with a message.
- `cancel` collapses into `clear` (no `cancelled` status).
- Folded away: `impossible`, `budget_limited`, `error`, `cancelled`, `interrupted` →
  all become `blocked(+reason)` or the clear action. The `reason` string carries the
  nuance; nothing branches on a distinct status.

## Decisions (locked)

- **D1** Fold `budget_limited` + `error` into `blocked(+reason)`. No cause enum — a human
  `reason` string only (display shows "Goal blocked" + reason; one headless exit code).
- **D2** Default `noProgressTurnLimit = 3` (today it is null → never blocks). Keeps the
  separate `failureTurnLimit = 3` malfunction guard.
- **D3** Light injection for `paused`/`blocked` (so an edited objective is visible next
  turn, points 3–4). Reverses today's "paused = silent". `active` keeps the full reminder.
- **D4** Completion message is **deterministic**: append an assistant-role message with the
  exact objective recap + tokens + wall-clock, then clear. Not model-generated (can't
  guarantee exact figures).

## The 5 behaviors (from Codex)

1. Set → `active`. (already true)
2. No progress for N turns → `blocked` (impossible folded in). Needs D2 + drop `impossible`
   from the evaluator verdict enum + UpdateGoal tool + injector prompt.
3. `blocked` resumable via `/goal resume`; a plain message just runs one turn (the loop
   gates on `active`, already true). Needs: `resumeGoal` accepts `blocked`; `blocked` leaves
   the terminal set; `createGoal` "blocking" = any persisted goal exists.
4. Edited goal visible next turn (resume or message). Needs D3 light injection.
5. Complete → box disappears + guaranteed completion message. Needs D4 + clear-on-complete.

## Commits

1. **Core consolidation (agent-core + coupled app surface).** Must land together — the
   `GoalStatus` union change breaks app switches at typecheck.
   - `session/goal.ts`: union → `active|paused|blocked|complete`; `blocked` persisted &
     resumable; `markBlocked({reason,evidence})` + `markComplete({reason,evidence})` replace
     `markBudgetLimited`/`markError`/`updateGoal`; `resumeGoal` accepts `blocked`; remove
     `cancelGoal` (→ surface calls `clearGoal`); `createGoal` blocking = goal-exists;
     `normalizeMetadata` drops stray `complete`; default `noProgressTurnLimit = 3`; update
     the documented union.
   - `agent/goal/continuation.ts`: verdict `complete` → completion flow (append message +
     `markComplete`); `blocked`/`impossible`/no-progress/budget/eval-failure → `markBlocked`;
     drop the budget wrap-up.
   - `agent/goal/evaluator.ts`: drop `impossible` verdict.
   - `agent/turn/index.ts`: maxSteps → `markBlocked('Model step limit reached')`; error →
     `markBlocked('Runtime error: …')`; abort → `pauseOnInterrupt` (unchanged).
   - `agent/injection/goal.ts`: full reminder for `active`; light context for
     `paused`/`blocked`; drop the terminal note + `impossible` from the prompt.
   - App surface coupled to the union: `cli/goal-prompt.ts` exit codes (complete 0 / blocked
     3 / paused 6); `tui/components/messages/goal-panel.ts` + `goal-markers.ts` +
     `chrome/footer.ts`; `controllers/session-event-handler.ts`; `tui/commands/goal.ts`
     (`cancel` → clear). SDK/RPC `cancelGoal` → `clearGoal`.
2. **Completion message (D4 / point 5).** Append the deterministic assistant completion
   message in the continuation controller; remove the live completion card.
3. **Docs + TRACKER.**

Gate every commit: agent-core + node-sdk + app typecheck, lint (0 errors), targeted tests.
