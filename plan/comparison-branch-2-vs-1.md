# Goal feature — Branch 2 vs Branch 1 implementation comparison

This document tracks how the **work-in-progress** `feat/goal-impl/2` branch compares
against the **completed** `feat/goal-impl/1` branch (the branch this file lives on).
It is updated automatically as each new `Phase N: …` commit lands on Branch 2, via a
background monitor watching the branch tip.

- **Branch 1 (reference, done):** all phases 1a → 6 (`abb938d`).
- **Branch 2 (WIP):** see per-phase sections below.

Legend: ✅ consistent · ⚠️ divergent but plausible · ❌ likely inconsistency / risk

---

## Phase 1a — core `SessionGoalStore`

| | Branch 1 (`040a06c`) | Branch 2 (`3a2dc95`) |
|---|---|---|
| Files touched | `agent/index.ts`, `errors/codes.ts`, `session/goal.ts`, `session/index.ts`, `session/rpc.ts`, test, `plan/TRACKER.md` | same core + **`rpc/core-api.ts`**, **`rpc/core-impl.ts`**, `plan/PROGRESS.md` |
| LOC (goal.ts) | 519 | 522 |
| Progress doc | `TRACKER.md` | `PROGRESS.md` |

Both branches independently arrived at a `SessionGoalStore` owning a single goal in
`metadata.custom.goal`, the same `GoalStatus` union, the same `errors/codes.ts` goal
error codes, and the same set of lifecycle methods (create/pause/resume/update/cancel/
clear + record* accounting + mark* runtime-terminal). The high-level shape agrees. The
internals, however, diverge in ways that will ripple through later phases.

### Findings

**❌ 1. SDK/RPC exposure is front-loaded on Branch 2.**
Branch 2's Phase 1a already edits `rpc/core-api.ts` and `rpc/core-impl.ts` to expose
`createGoal/getGoal/pauseGoal/resumeGoal/cancelGoal/clearGoal` on `SessionAPI`. Branch 1
keeps Phase 1a as a pure store + session wiring and defers all SDK exposure to **Phase 2**
("expose goal lifecycle via SDK and wire the /goal slash command"). Not a bug, but the
phase boundaries differ — Branch 2's Phase 2 will likely look smaller / different. Worth
watching that Branch 2 doesn't *also* re-touch these files in its Phase 2.

**❌ 2. `GoalSnapshot` is a fundamentally different type.**
- Branch 1: a *flattened, computed* view — all goal fields hoisted to the top level
  plus a nested `budget: GoalBudgetReport` (remaining/limits/`*Reached`/`overBudget`).
  Also exposes `GoalBudgetReport`, `isTerminalGoalStatus()`.
- Branch 2: a *wrapper* — `{ goal: SessionGoalState | null, remainingTokens, overBudget,
  tokenBudgetReached, turnBudgetReached, wallClockBudgetReached }`. No `GoalBudgetReport`
  type; no `remainingTurns` / `remainingWallClockMs`; budget limits stay nested under
  `goal.budgetLimits`.

This is the biggest divergence. Every downstream consumer (slash command output, model
tools, continuation controller, evaluator, headless summary) reads the snapshot, so the
two branches' later phases will not be line-comparable here. Branch 2 also drops the
distinction between `GoalToolResult` (`{goal: SessionGoalState|null}`) and the snapshot.

**❌ 3. `recordModelReport` loses dedicated fields on Branch 2.**
Branch 1 stores `lastModelReportStatus`, `lastModelReportReason`, `lastModelReportEvidence`
as first-class state fields and never changes status (it records the model's *requested*
terminal state as evidence for the continuation controller / evaluator to act on).
Branch 2 drops those three fields entirely and instead appends an entry to `lastEvidence`
(`{ kind: 'model_report', summary: "<status>: <reason>" }`). Branch 1's Phase 4c/4d
continuation+evaluator logic keys off `lastModelReportStatus`; if Branch 2 keeps this
shape it will need a different continuation strategy. **Track whether Branch 2's later
phases can recover the requested status from a stringified evidence summary.**

**⚠️ 4. `GoalEvidence` shape differs.**
- Branch 1: `{ summary, detail?, source? }`.
- Branch 2: `{ kind, summary }`.
Both persist in the durable record, so they are not interchangeable across branches.

**⚠️ 5. `GoalActor` typing.**
Branch 1 defines a typed union `'user'|'model'|'evaluator'|'continuation'|'runtime'|'system'`
and threads it through every input. Branch 2 uses plain `string` for `actor` and hard-codes
literals (`'user'`, `'runtime'`, `'model'`, `'evaluator'`) at call sites. Branch 2 loses
compile-time actor validation.

**❌ 6. Store ownership model: callbacks vs cached state.**
- Branch 1: stateless store over `readState()` / `writeState()` callbacks — metadata is the
  single source of truth, re-read on every operation, and `writeState` is **awaited**.
- Branch 2: caches `this.state` in memory, reads metadata only in the constructor, and
  persists via fire-and-forget **`void this.persist()`** (sync methods).

Risks on Branch 2: (a) if session metadata is mutated elsewhere, the cached `this.state`
goes stale; (b) fire-and-forget writes are not ordered/awaited, so a crash or a rapid
create→update sequence can lose or reorder a persist; (c) `createGoal` etc. are synchronous
and return before the write lands. Branch 1's awaited model is safer.

**❌ 7. Usage deltas are not clamped on Branch 2.**
Branch 1 clamps with `Math.max(0, input.tokenDelta)` / `Math.max(0, input.wallClockMs)`.
Branch 2 adds the raw delta (`current.tokensUsed + input.tokenDelta`), so a negative delta
would *decrement* recorded usage. Minor but a real defensiveness gap.

**⚠️ 8. Goal ID generation.**
Branch 1: `randomUUID()`. Branch 2: `goal-${Date.now()}-${counter}` with a module-level
counter that resets per process. Fine within a session, but not globally unique and not
collision-proof across restarts within the same millisecond+counter window.

**⚠️ 9. `incrementTurn` actor.**
Branch 2 sets `updatedBy: 'runtime'` and overwrites `lastEvidence` with the (possibly
undefined) input evidence on every turn; Branch 1 only sets `lastEvidence` when provided.
Branch 2 can therefore clear previously recorded evidence on a bare `incrementTurn()`.

**✅ 10. Shared, consistent pieces.**
`errors/codes.ts` goal error codes are identical (51 added lines on both). `GoalStatus`
union, `GoalBudgetLimits`, `DEFAULT_GOAL_TURN_BUDGET = 20`, `MAX … = 4000`, the
create-with-`replace` guard, and pause/resume/cancel/clear semantics all agree at the
behavioral level.

### Net assessment for Phase 1a
Same architecture and intent, but **not drop-in compatible**: the snapshot type, evidence
shape, model-report storage, and persistence model differ enough that downstream phases
will diverge structurally. The items most likely to become *functional* problems later
are #3 (model-report fields the continuation/evaluator need) and #6 (fire-and-forget
persistence). Everything else is stylistic or a minor robustness gap.

---

## Phase 1b — goal audit records, replay ignore, resume normalization

| | Branch 1 (`70ee3c6`) | Branch 2 (`cc1f6c8`) |
|---|---|---|
| Files | records/index.ts, records/types.ts, goal.ts, session/index.ts, 2 tests, TRACKER.md | same minus TRACKER.md |

**This phase converges strongly.** Both branches independently arrived at the same design:

- **✅ Audit-only goal records.** Identical taxonomy — `goal.create`, `goal.update`,
  `goal.account_usage`, `goal.continuation`, `goal.report`, `goal.evaluate`, `goal.clear` —
  and both wire them into `restoreAgentRecord` as **replay-ignored** (goal state is restored
  from `metadata.custom.goal`, never rebuilt from records). Same architectural decision.
- **✅ `normalizeMetadata` resume semantics match exactly:** drop malformed goals, drop a
  stale `cancelled` goal (clear didn't complete), convert `active` → `paused` with
  reason `"Paused after session resume"` and emit a `goal.update` audit record, leave
  `paused`/terminal goals intact.
- **✅ Pending-records queue + flush pattern matches:** both buffer audit records emitted
  before the main-agent sink exists and flush via `flushPendingRecords()`; both wire the
  sink as `() => this.agents.get('main')?.records` and flush around `normalizeMetadata`.

### Findings (divergences, all minor)

**⚠️ 1. Async vs sync, again.** Branch 1's `normalizeMetadata` is `async` and awaits each
write; Branch 2's is sync with `void this.writeMetadata()`. Same behavior, same persistence
risk already noted in Phase 1a #6.

**⚠️ 2. Record type fidelity.** Branch 1's record event types reuse the strong
`GoalActor / GoalBudgetLimits / GoalEvidence / GoalStatus` types from `session/goal`.
Branch 2 declares them loosely (`status: string`, `actor: string`,
`budgetLimits: Record<string, unknown>`, inline `{ kind; summary }[]`). Consistent with the
Phase 1a typing divergence; no functional impact but weaker type-safety on the audit path.

**⚠️ 3. `goal.account_usage` record shape differs.**
- Branch 1: discriminated — `usageKind: 'token' | 'wall_clock'` + `delta` + both
  `tokensUsed`/`wallClockMs` snapshots + optional `source`.
- Branch 2: no discriminant; distinguishes by which optional field is present
  (`tokensUsed?` vs `wallClockMs?`), `source` is required, and the wall-clock record passes
  the **sentinel** `source: 'wall_clock'` rather than a real source. Slightly hacky but works.

**⚠️ 4. `goal.create` / `goal.clear` record fields.** Branch 1's `goal.create` carries
`actor`; Branch 2 carries `completionCriterion` instead (no actor). Branch 1's `goal.clear`
carries `actor` + `reason`; Branch 2's carries only `goalId`. Branch 2's records are
lighter and lose the actor attribution that Branch 1 keeps end-to-end.

**⚠️ 5. Validation helper.** Branch 1 factors a reusable `isValidGoalState()`; Branch 2
inlines the check against a `validStatuses` array. Cosmetic.

### Net assessment for Phase 1b
The hard part — deciding records are audit-only and getting resume normalization right — is
**implemented the same way on both branches**. Remaining differences are the same
typing/async stylistic gaps already flagged in Phase 1a, plus lighter audit-record payloads
on Branch 2 (notably the dropped `actor` attribution). No new functional risk.

---

<!-- New phases from Branch 2 will be appended below as commits land. -->
