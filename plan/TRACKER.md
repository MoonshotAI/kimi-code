# `/goal` Implementation Tracker

High-level goal: implement the `/goal` command (autonomous goal mode) in the kimi-code
coding agent, following the phase plans in this directory.

## Status legend

- ⬜ Not started
- 🟡 In progress
- ✅ Complete

## Phases

| Phase | Title | Status | Commit |
|-------|-------|--------|--------|
| 1a | Core session goal state | ✅ | 040a06c |
| 1b | Goal audit and resume lifecycle | ✅ | 70ee3c6 |
| 2  | SDK API and `/goal` command surface | ✅ | c14b025 |
| 3  | Model goal tools | ✅ | c5d8a90 |
| 4a | Goal context injection | ✅ | 687654c |
| 4b | Goal usage accounting | ✅ | aea58a5 |
| 4c | Goal continuation loop | ✅ | 0899188 |
| 4d | Goal evaluator | ✅ | d0dc822 |
| 5  | End-to-end integration and gates | ✅ | 674b2c1 |
| 6  | Headless goal mode and hardening | ✅ | abb938d |
| 7  | Goal UX and budget model | 🟡 | see below |
| 8  | Goal state consolidation | ✅ | 8ab5078, 60b6b4c |

## Phase 7: Goal UX and budget model

Plan: `plan/phase-07-goal-ux-and-budget.md`. Sequenced commits:

| # | Commit | Status | Hash |
|---|--------|--------|------|
| 1 | Generic subcommand autocomplete (`/goal` subcommands + flags) | ✅ | 7cbb37f |
| 2 | Budget model: drop default turn cap, surface counters to evaluator | ✅ | — |
| 3 | `goal.updated` event spine + terminal stats on `goal.update` record | ✅ | cc35725, 6a |
| 4 | Footer badge | ✅ | cc35725 |
| 5 | `/goal` status box | ✅ | e65abcb |
| 6a | `goal.updated` change payload + terminal stats on record | ✅ | — |
| 6b | Transcript markers + completion card (live) | ✅ | — |
| 6c | Transcript markers + completion card (resume) | ⏸ deferred | — |

- **Commit 1:** added a generic `completeArgs` capability to the slash-command registry
  (`KimiSlashCommand.completeArgs`, generic `completeLeadingArg` helper), wired `/goal` to
  offer `status`/`pause`/`resume`/`cancel`/`clear`/`replace` + `--max-*` flags, and forwarded
  it to pi-tui's `getArgumentCompletions` in `setupAutocomplete`. The goal completion spec
  lives in `registry.ts` (metadata layer) so it imports only the leaf `complete-args.ts` and
  never pulls the command handler / SDK into the widely-imported registry. Note: full-suite
  parallel runs flake on timing-sensitive TUI/telemetry tests under CPU contention (reproduces
  on baseline); `--no-file-parallelism` is green (1059 passed).
- **Commit 2:** dropped the default turn cap — `normalizeBudgetLimits` no longer fills `turnBudget`
  (removed `DEFAULT_GOAL_TURN_BUDGET`); an unflagged goal now has no work caps and runs until the
  evaluator judges it terminal. Kept a malfunction guard only: default `failureTurnLimit`
  (`DEFAULT_GOAL_FAILURE_TURN_LIMIT = 3`). The evaluator prompt now surfaces live counters
  (`Progress so far: N turn(s), <elapsed>, <tokens> tokens`) + configured hard budgets and asks
  whether any stop condition stated in the objective has been reached — so the evaluator can enforce
  natural-language stop-clauses. Added TUI + headless "no stop condition" nudges. Tests updated:
  unbounded goal does not hard-stop; explicit `turnBudget` still caps; evaluator prompt carries the
  counters + stop-condition check. agent-core 2367, app 185, typecheck + lint clean.
- **Commit 4 (+ partial 3):** built the `goal.updated` event spine and the footer badge. Added
  `GoalUpdatedEvent { snapshot }` to agent-core's event union, re-exported via the SDK; the goal
  store gained an `onGoalUpdated` callback emitted through a centralized `persistState()` on every
  durable change *except* per-step token/wall-clock accounting (silent, to avoid chatty updates);
  `Session` wires it to `rpc.emitEvent`. TUI: `AppState.goal`, a `goal.updated` handler, and a
  footer badge `[goal ● <status> · <elapsed> · N turns]` (raw turn count; `used/limit` only when a
  turn budget is set; shown only for active/paused; cleared on terminal). Tests: store emits on
  lifecycle but not token usage; footer badge variants. **Deferred to Commit 6 (the 🟡 part of 3):**
  the `change` payload (verdict/lifecycle/terminal detail) and terminal stats on the `goal.update`
  record, which the transcript markers + completion card need. agent-core 2368, node-sdk 153, app
  1065 (sequential), all typechecks + lint clean.
- **Commit 5:** `/goal status` (and bare `/goal`) now renders a boxed panel instead of plain text.
  New `components/messages/goal-panel.ts` builds the lines (objective as a `▌` blockquote, then
  `Running` / `Turns` / `Tokens` / `Evaluator`, plus a `Stop` row when budgeted or a dim "No stop
  condition — runs until evaluated complete" note when not; terminal goals get a `Status` row and no
  `Stop` row), reusing the existing `UsagePanelComponent` box (same chrome as `/usage`), titled
  `Goal · <status>`. Removed the old plain-text `formatGoalStatus`/`formatDuration`. Tests:
  `buildGoalReportLines` content (active/budgeted/terminal/criterion/verdict/long-objective).
  app 1073 (sequential), typecheck + lint clean.
- **Commit 6a (finishes 3):** enriched `goal.updated` with an optional `change` (`GoalChange`:
  kind `lifecycle`/`verdict`/`terminal`, plus status/verdict/reason/evidence/stats), emitted from the
  store via `persistState({ change })` on the relevant mutations (lifecycle: pause/resume/cancel;
  verdict: evaluator verdict; terminal: updateGoal + runtime terminals — with a counter `stats`
  snapshot); create/turn-increment/report stay snapshot-only. Added terminal usage counters
  (`turnsUsed`/`tokensUsed`/`wallClockMs`) to the `goal.update` audit record for resume
  reconstruction. Re-exported `GoalChange`/`GoalChangeStats` through agent-core (`core-api`) and the
  SDK. Tests: store emits typed change for lifecycle/verdict/terminal and none for snapshot-only.
  agent-core 2369, node-sdk 153, typecheck + lint clean. Live rendering is Commit 6b; resume 6c.
- **Commit 6b (live rendering):** `SessionEventHandler.handleGoalUpdated` now, on a `change`, renders
  into the transcript: terminal → a prominent completion card (reuses the `/goal` box —
  `buildGoalReportLines` + `UsagePanelComponent` over the terminal snapshot, so it shows objective +
  Status + time/turns/tokens); lifecycle (paused/resumed/cancelled) and `no_progress` verdict → a
  low-profile `GoalMarkerComponent` (dim `◦ Goal …` one-liner, ctrl+o-expandable to the reason,
  participating in the shared tool-output expand). Plain `continue`/report/snapshot-only changes stay
  silent. New `components/messages/goal-markers.ts`. Tests: marker build matrix (verdict/lifecycle/
  terminal-null) + collapse/expand. app typecheck + lint clean; full app suite green. Resume
  reconstruction (scrollback after `/resume`) is Commit 6c.
- **Commit 6c (deferred):** rebuild goal markers + completion card on resume/scrollback. Design
  decided, not yet implemented. The TUI replay rebuilds from a curated `AgentReplayRecord` stream
  (resumed.ts); `goal.*` records are excluded (audit-only). Plan:
  - Add a `{ type: 'goal'; change: GoalChange }` variant to `AgentReplayRecord`; during record
    restore (`agent/records/index.ts`, currently a no-op for `goal.*`), `replayBuilder.push` a goal
    change derived from `goal.update` (lifecycle paused/resumed/cancelled; terminal complete/blocked/
    impossible/budget_limited/error) and `goal.evaluate` (verdict). Use the
    `turnsUsed`/`tokensUsed`/`wallClockMs` already added to `goal.update` (6a) for stats.
  - In `SessionReplayRenderer.renderRecord`, handle the `goal` case → `buildGoalMarker` for
    lifecycle/verdict; for terminal render a **stats-only completion card** (decided): a box titled
    `Goal · <status>` showing `<status> — <reason>` + Running/Turns/Tokens from the record stats.
    (Deliberately simpler than the live card, which has the full snapshot incl. objective/budgets —
    historical objective/budgets aren't reliably reconstructable from current durable state.)
  - Needs a `buildGoalCompletionLines(change)` (stats-based) shared by the resume card; live can keep
    the richer `buildGoalReportLines(snapshot)` box.
  - Tests: replay of `goal.*` records produces markers + a stats-only completion card.

## Phase 8: Goal state consolidation

Plan: `plan/phase-08-goal-state-consolidation.md`. Collapsed the lifecycle to the minimal,
unambiguous set validated against Codex's `/goal`. Preceded by a separate fix that removed the
terminal `interrupted` state (an aborted turn now pauses — see Post-implementation fixes).

| # | Commit | Status | Hash |
|---|--------|--------|------|
| 1 | Core consolidation (state machine + continuation/evaluator/turn/injector + app surface) | ✅ | 8ab5078 |
| 2 | Deterministic completion message (replaces the live card) | ✅ | 60b6b4c |

- **Statuses → `active` / `paused` / `blocked` / `complete`.** The durable record only ever
  holds `active`, `paused`, or `blocked`; `complete` is transient (announce-then-clear) so the
  box disappears. `impossible`, `budget_limited`, `error`, `cancelled` (and the earlier
  `interrupted`) are folded away: an unachievable goal, an exhausted budget, a no-progress
  streak, and a runtime/evaluator failure all become `blocked(+reason)`; "cancel" is just a clear
  that returns the discarded snapshot. The `reason` string carries the nuance; nothing branches
  on a distinct status.
- **`blocked` is resumable** (a sibling of `paused`, not a dead end): `resumeGoal` accepts it,
  `/goal resume` re-activates it, and a plain message just runs one normal turn (the loop gates on
  `active`). `markComplete`/`markBlocked` replace `updateGoal`/`markBudgetLimited`/`markError`;
  `createGoal` now blocks on *any* existing goal; `normalizeMetadata` drops a stray `complete`.
- **Default `noProgressTurnLimit = 3`** so an unclear/unachievable goal (e.g. "prove me wrong",
  "1+1=3") blocks after a few stuck turns instead of spinning. Dropped the evaluator `impossible`
  verdict and the UpdateGoal tool's `impossible` option. Dropped the budget wrap-up segment — a
  budget/cap now blocks (resumable) directly.
- **Light injection for `paused`/`blocked`** (reverses "paused = silent"): a non-demanding note
  keeps the current objective visible so an edit takes effect next turn, without driving the loop.
  `active` keeps the full reminder + budget guidance.
- **Completion message (point 5):** `buildGoalCompletionMessage(snapshot)` in agent-core (exported
  via the SDK) is the single source of truth for "✓ Goal complete — <reason>. Worked N turns over
  <time>, using <tokens> tokens." The continuation controller appends it as an assistant message
  (persisted, renders on resume); the TUI renders the same text live off the `goal.updated`
  terminal event. Replaced the live completion card.
- **App surface:** exit codes simplified (complete 0 / blocked 3 / paused 6); `/goal` panel
  (blocked shows reason + stop; complete is the message), markers (`Goal blocked`), `/goal cancel`
  → clear. Gates green: agent-core 2373, node-sdk 153, app 1079; typecheck + lint (0 errors).
- **Known follow-up:** the completion message is appended as an assistant message adjacent to the
  model's last assistant message; if a provider rejects consecutive assistant messages on the next
  turn this may need a role/merge tweak. Not observed in tests (the turn ends on completion).

### Phase 8 follow-ups (post-review consistency pass)

A design-consistency review after Phase 8 surfaced four items; the two bugs and two of the
cleanups are now fixed.

- **Resume is a fresh attempt (bug):** `resumeGoal` now resets `consecutiveNoProgressTurns` /
  `consecutiveFailureTurns` (and clears `terminalReason`). A goal `blocked` on the no-progress or
  evaluator-failure limit gets a full N turns again on resume, not a single strike. (`801832b`)
- **Footer badge shows `blocked` (bug):** `formatGoalBadge` renders active / paused / blocked
  (blocked = warning dot); only the unset/`complete` cases hide it. A resumable goal stays visible.
  (`801832b`)
- **`cancel` is the single discard:** dropped `/goal clear`, `clearGoal` (store / RPC / SDK), and
  the `clear` subcommand/autocomplete. `cancelGoal` is the one user-facing remove (internal
  `clearInternal` still backs `createGoal` replacement). `/goal clear` now parses as an objective.
- **`GoalChange.kind` renamed `terminal` → `completion`:** since the consolidation it only ever
  meant `complete` (`blocked` rides on `lifecycle`), so the name now matches.
- **Injection intensity by status (#3):** three levels — `active` = full reminder (loud),
  `blocked` = a light, non-demanding note (the model stays aware so the user can unstick it),
  `paused` = **silent**. Pausing is the deliberate "set it aside" gesture, so a parked goal no
  longer whispers into every unrelated turn; `/goal resume` restores the full reminder (and
  surfaces any edit made while paused). `complete` clears, so it never injects.
- **Over-budget injection guidance removed (#5):** the active reminder kept the within-budget and
  "nearing a budget — converge" bands but dropped the over-budget "report the best terminal state
  via UpdateGoal" line, which was stale (the runtime auto-`blocks` on over-budget before the
  evaluator runs, so the model could never act on it).

### Fix: removed the `UpdateGoal` tool (model self-report) entirely

- **Motivation:** `UpdateGoal` never changed goal status — it called `recordModelReport`, which only
  stored `lastModelReport*`, consumed in exactly two places (the evaluator prompt, where it was
  explicitly labeled *"a claim to verify, not truth"*, and the active reminder). The independent
  evaluator is the sole authority on status and judges from the conversation transcript regardless,
  so the tool was a no-op control channel. Yet it carried real cost: it needed approval in default
  mode (not in the default-approve list → fallback ask), rendered raw args JSON on Ctrl-O, and sat
  permanently in the model's schema even with no goal.
- **Decision:** delete the tool and rip out the dormant plumbing rather than leave dead surface.
  The model now signals completion/blockage **in prose**; the evaluator reads it from the transcript
  and decides. One decision-maker, one source of truth.
- **Removed:** `tools/builtin/goal/update-goal.{ts,md}` + its registration/export and the `UpdateGoal`
  entry in the default profile; `SessionGoalStore.recordModelReport` and the `lastModelReport*`
  state/snapshot fields; the `goal.report` audit record type; `GoalEvaluatorModelReport` and the
  evaluator's optional `modelReport` input + prompt line; the type-only `UpdateGoalControlInput`
  stub and its re-exports. Rewrote `CONTINUATION_PROMPT` and the active reminder to ask the model to
  state its conclusion explicitly (no tool), noting an independent evaluator decides.
- **Note:** `CreateGoal` and `GetGoal` remain (they do real work — create/inspect the goal).

### Refactor: sequential-turn goal driver (mega-turn → driveGoal) + minimal `UpdateGoal(status)`

A goal used to run as one *mega-turn*: the continuation controller reached into the loop
(`shouldContinueAfterStop` / `shouldContinueOnMaxSteps` / `resetStepBudget`) to keep a single
`runTurn` alive across many segments. That leaked complexity into the shared loop and produced odd
UX (one giant turn, whole-turn cancellation, the self-audit echoed in both reasoning and answer).
Replaced with the honest model: a goal is **N sequential ordinary turns** driven by a loop — the
autonomous stand-in for the user typing "continue".

- **Loop primitive (`loop/run-turn.ts`, `loop/types.ts`):** deleted `shouldContinueOnMaxSteps`,
  `MaxStepsDecision`, `LoopMaxStepsContext`, and the `stepBudgetBase`/`resetStepBudget` segment
  machinery. `maxSteps` bounds a (normal) turn again; `shouldContinueAfterStop` stays for steer +
  the external Stop hook only.
- **`TurnFlow` (`agent/turn/index.ts`):** split into `runOneTurn` (one full turn, goal-agnostic,
  owns `turn.started`/`turn.ended` + per-turn bookkeeping) and `driveGoal` (the sequential driver).
  `turnWorker` gates on `goals.currentGoal?.status === 'active'` → `driveGoal` else `runOneTurn`.
  The driver runs a turn, accounts turn/wall-clock, enforces hard budgets (`overBudget` → blocked),
  then reads the status the model set: cleared = `complete`, `blocked`/`paused` stop, `active`
  re-injects the reminder and runs the next turn. Abort → pause; failure → blocked.
  - **Gate rationale:** the app only has the `prompt` RPC, so the single-vs-driver choice must be
    server-side. `status === 'active'` is a sufficient signal because `active` is produced *only* by
    create/resume (each immediately followed by a prompt) and every stop clears it; resume demotes a
    stale `active` to `paused`. So there's never an "active but idle" goal to mis-trigger the gate.
  - **Subtlety fixed:** the terminal `turn.ended` and the `activeTurn` release must happen in the
    *same synchronous frame* (the old code did; the naive split introduced an `await` between them,
    so a test/host prompting right after `turn.ended` hit the busy guard and hung). `runOneTurn` now
    emits `turn.ended` and clears `activeTurn` (for standalone turns) together; the error event is
    emitted just after `turn.ended`, as before.
- **`UpdateGoal(status)` recovered, minimal:** single enum arg `complete | paused | blocked`,
  mapping to `markComplete` / `pauseGoal` / `markBlocked` (actor `model`); `complete` appends the
  deterministic completion message. Registered like its siblings but **filtered out of `loopTools`
  when no goal exists**, so the model only sees it during a goal. This replaces the evaluator: the
  model owns its terminal status directly; the driver just reads it at each boundary.
- **Removed:** `agent/goal/continuation.ts` and `agent/goal/evaluator.ts`; the
  `recordEvaluatorVerdict` / `recordEvaluatorFailure` store methods, `lastEvaluator*` fields, the
  `goal.evaluate` audit record, the `'verdict'` `GoalChangeKind`, the "Latest evaluator verdict"
  reminder/panel lines, and `goalEvaluatorFactory`. The no-progress/failure streak counters stay in
  the store **dormant** (the backstop, below, will revisit them) but nothing increments them now.
- **Deferred — the backstop:** there is currently no automatic stop for a model that loops without
  ever calling `UpdateGoal`. The hard ceiling is existing resource exhaustion (context/budget). The
  refined reminder-based backstop is captured below.

### Backstop (refined; not yet implemented)

The driver makes this trivial and number-free. Each boundary it already knows, for free, whether the
turn took any action and what the status is. So:

- **Trigger:** a continuation turn that took **no tool action** *and* left the status **active**
  (the model continued without doing or deciding anything) — the exact runaway signature, detectable
  with zero thresholds, firing the first time it happens.
- **Response:** inject one firm reminder before the next turn — *"your last turn took no action and
  didn't update the goal; decide now: `UpdateGoal('complete')`, `UpdateGoal('blocked')`, or make real
  progress"* — escalating if it recurs. A reminder, never a kill (a false positive on a pure-thinking
  turn costs nothing).
- **Hard floor:** existing resource ceilings (context window / configured token budget), not a new
  goal-specific magic number.

### Follow-ups after the sequential-turn refactor

- **Removed the dead evaluator-phase spinner.** With the evaluator gone, nothing emitted
  `goal.evaluation.started` / `goal.evaluation.ended`, so the "Reviewing progress…" rotating label,
  the `goal-eval` activity mode, the `goalEvaluating`/`goalEvalLabel` app state, and the two events
  were all inert. Deleted them.
- **Consistent no-goal messages.** `/goal pause` and `/goal resume` with no goal leaked a raw red
  `[goal.not_found] No current goal`; they now show calm status lines ("No goal to pause/resume."),
  matching `status` ("No goal set…") and `cancel` ("No goal to cancel."). `replace` with no
  objective is treated as a usage *hint* (status, not a red error) via a `severity` on the parser's
  error result. Red is now reserved for genuine failures (objective too long, duplicate goal, SDK
  errors).
- **`UpdateGoal` timer / approval / authorship** — see the commit; `UpdateGoal` + `GetGoal` are now
  default-approved, the wall-clock timer is live (clock-anchored in the store), and the completion
  message is appended by the `UpdateGoal` tool from the final snapshot.

## Post-implementation fixes

### Fix: `maxStepsPerTurn` no longer fatally caps long goals (continuation checkpoint)

- **Symptom:** a long goal died with `loop.max_steps_exceeded` (e.g. maxSteps=100).
- **Root cause:** goal continuation keeps the *same* loop-level `runTurn` alive across all
  continuations, so the single `steps` counter accumulated across the whole goal and
  `maxStepsPerTurn` capped the entire run (not one turn). The Phase 4c reconciliation only caught
  the boundary on a *terminal* step; an uninterrupted tool-call streak threw mid-stream and the
  goal stopped with a runtime error.
- **Fix:** `maxStepsPerTurn` now bounds a single continuation **segment**.
  - `run-turn.ts` tracks a `stepBudgetBase`; the cap compares `steps - stepBudgetBase`. Goal
    continuations return `resetStepBudget: true`, which advances the base (steps stay monotonic for
    numbering).
  - New `LoopHooks.shouldContinueOnMaxSteps` is consulted *before* throwing. For an active goal it
    runs the same evaluator-driven decision (your suggestion: validate at the cap, then continue or
    stop); it returns `undefined` for non-goal turns so the cap still throws as before.
  - `GoalContinuationController` extracted a shared `decide()` used by both the stop hook and the
    cap checkpoint; the old `remaining`/`Model step limit reached` reconciliation was removed.
  - The goal's real ceiling is now its own budgets (`turnBudget` default 20, token, wall-clock) and
    the evaluator's `no_progress`/`failure` limits — `maxStepsPerTurn` is just a per-segment bound.
- **Tests:** replaced the old reconciliation unit tests with `shouldContinueOnMaxSteps` cases
  (checkpoint continue/reset, evaluator-ends-at-cap, undefined for non-goal, hard-budget stop);
  updated the integration test to prove a goal runs *more* total steps than `maxStepsPerTurn`
  without a fatal error and stops via its own turn budget. Full agent-core suite (2360) green;
  typecheck + lint OK across packages.

### Fix: budget wrap-up no longer throws `loop.max_steps_exceeded` (residual cap gap)

- **How it surfaced:** replay of session `398e1aba` (worktree `feat-goal-impl-2`, pre-fix code at
  `76d4141`) showed the goal marked `budget_limited` with `terminalReason: "Model step limit
  reached"` and `turnsUsed: 0` — the *old* reconciliation fired at the very first 100-step cap. The
  wire log then had 4 consecutive turns each ending at exactly 100 steps: turn#0 prematurely killed
  the goal, then every "Please continue" ran 100 steps and threw, because once the goal is terminal
  the cap hook returns `undefined` → fatal error. This confirmed the primary fix above (removes the
  premature termination) but also revealed a residual gap.
- **Residual gap:** after a *legitimate* budget wrap-up makes the goal terminal, the wrap-up segment
  gets a fresh step budget to summarize. If the model keeps calling tools instead of summarizing and
  hits the cap again, `shouldContinueOnMaxSteps` saw a non-active goal and returned `undefined` →
  threw `loop.max_steps_exceeded` instead of stopping cleanly.
- **Fix:** `GoalContinuationController` tracks an `engaged` flag (set once `decide()` runs for an
  active goal). When the cap is hit and the goal is terminal/gone, it returns `{ continue: false }`
  (graceful stop) **iff** goal continuation already drove this turn; otherwise `undefined` (a stale
  terminal goal from a resumed session, or no goal, still throws as vanilla turns do).
- **Tests:** added a case asserting that a second cap hit after a budget wrap-up returns
  `{ continue: false }`. agent-core suite (2361) green; typecheck + lint OK.

### Fix: goal context injected at boundaries, not per step (caching + compaction safety)

- **How it surfaced:** replay analysis of session `398e1aba` showed the `GoalInjector` appended the
  full goal reminder (~439 tokens; the objective is the entire user prompt) **before every model
  step** — 100 copies in one turn, never evicted. Because the whole history is re-sent each step,
  that is ~44K tokens of live duplication and ~2.2M tokens of cumulative re-send in a single turn, a
  meaningful slice of the 13.1M-token run and a direct cause of 2 full compactions. A cross-check of
  Codex's replay (via another agent) confirmed Codex injects the goal only at task boundaries
  (~3×/goal), not per step — the verbatim objective is fine; the **per-step cadence** was the bug.
- **Caching note:** an earlier "sticky single copy" idea (strip the old reminder, re-append at the
  tail) was rejected — stripping mutates the prefix and busts prompt caching from that point at every
  boundary. The current per-step design is already append-only/cache-friendly; its only fault is
  cadence. So the fix keeps append-only and just lowers the cadence to boundaries.
- **Fix (append-only, boundary cadence):**
  - `InjectionManager` no longer runs `GoalInjector` in the per-step `inject()` loop; it holds the
    goal injector separately and exposes `injectGoal()` (append-only; no-op off goal mode / non-main).
  - `injectGoal()` is called at the three real boundaries: **turn start** (`turn/index.ts` before the
    step loop), **each continuation** (`GoalContinuationController.continueToward()`), and **after
    compaction** (`FullCompaction` post-`applyCompaction`).
  - The post-compaction call is mandatory: `applyCompaction` collapses the prefix into a summary and
    drops any goal reminder living there, so without re-injection the goal silently leaves context.
  - Net: copies drop from ~100/turn to ~one per boundary (bounded by the turn budget between
    compactions); the freshest copy sits at the tail for recency; the prefix is never mutated, so
    prompt caching is preserved; compaction prunes stale copies.
- **Tests:** per-step `inject()` adds no goal reminder; `injectGoal()` is append-only (N calls → N
  records); continuation re-injects once per boundary and not when the evaluator ends the goal.
  agent-core suite (2365) green; typecheck + lint OK.

### Fix: active completion self-audit prompt + terminal-goal note (engagement / awareness)

- **Motivation:** replay showed the model never called the goal tools (0 `UpdateGoal`/`GetGoal`); it
  tracked work with its own `TodoList` and relied on passive injection. The injected/continuation
  text only said "*when finished*, call UpdateGoal" — no forcing function. The Codex cross-check
  showed Codex's injected message instructs an explicit *completion audit* each task, which is why
  its model engages. (`UpdateGoal` is terminal-only — `complete`/`blocked`/`impossible` — so this is
  about prompting an audit, not a per-turn `active` ping.)
- **Active self-audit:** `CONTINUATION_PROMPT` and the injected reminder's closing line now tell the
  model to self-audit against the objective/criteria each time it resumes and to call `UpdateGoal`
  the moment it judges the goal terminal. The independent evaluator stays the authority; the model
  report flows in as evidence (existing `lastModelReport*` plumbing).
- **Terminal-goal note:** `GoalInjector` previously emitted nothing for a non-active goal, so a
  finished/`budget_limited` goal went completely silent (the replay's resumed-session symptom). It
  now announces a terminal goal **once** (`<goalId>:<status>` dedupe) — "no longer active; start a
  new goal or raise its budget" — then stays quiet so it never nags; paused goals remain silent.
- **Tests:** terminal goal announces once then is silent on the next boundary. agent-core suite
  (2365) green; typecheck + lint OK.

### Fix: Esc no longer kills a goal — aborted turn pauses (resumable) instead of `interrupted`

- **Symptom / design mistake:** pressing Esc during an active goal (e.g. to move the laptop and keep
  working) marked the goal **terminally** `interrupted` — no cure for regret, the goal was dead and
  had to be re-issued.
- **Insight:** the goal loop only advances inside one live `runTurn`, so "the turn died" is the same
  condition whether by Esc or by process restart. `normalizeMetadata` already handles the restart
  case by demoting an `active` goal to `paused` (resumable via `/goal resume`). `interrupted` was
  just the *same situation reached by a different door*, routed to a dead-end — an inconsistency, not
  a needed state.
- **Fix:** removed the `interrupted` `GoalStatus` entirely (union, `TERMINAL_STATUSES`,
  `ALL_GOAL_STATUSES`). Replaced `markInterrupted` (terminal) with `pauseOnInterrupt` (parks an
  active goal as `paused`, emits a `lifecycle` change so the marker/badge update, no-ops for a
  non-active goal). Both `turn/index.ts` abort sites (the normal `'aborted'` return and the
  `isAbortError` catch) now call it. A user Esc and a system/shutdown abort are deliberately *not*
  distinguished — both pause, both resumable. Headless: the freed exit code `6` is repurposed
  `interrupted → paused` (an aborted/SIGINT'd headless goal parks as `paused`, still non-zero, not
  success). TUI status-color grouping dropped `interrupted` from the dim bucket.
- **Tests:** `pauseOnInterrupt` parks-as-paused + emits lifecycle change + stays resumable; no-ops
  for non-active; continuation cancel test now asserts `paused`; `updateGoal`-reject and exit-code
  lists updated. agent-core (101 goal/tools/continuation) + app (goal-prompt/panel/markers) green;
  all three typechecks + lint (0 errors) clean.

## Detours / Notes

(None yet.)

## Log

- Phase 1a complete: `SessionGoalStore` (`session/goal.ts`) owns durable goal state in
  `metadata.custom.goal`; `Session`/`Agent` wired with the store; goal error codes added;
  `updateSessionMetadata` reserves `custom.goal`. 33 goal tests pass; typecheck clean; no
  agent-core imports in app src.

### Detour notes (Phase 1a)

- `createGoal` accepts an optional `actor` (default `'user'`) so both the user path and the
  Phase 3 model `CreateGoal` tool can set `startedBy`/`updatedBy`. Plan signature unchanged
  otherwise.
- `recordEvaluatorVerdict` is implemented in 1a (state side); the consecutive-failure increment
  path is deferred to Phase 4d (recordEvaluatorVerdict resets failures on a produced verdict).
- Audit records (`goal.*` wire entries) are intentionally NOT wired in 1a — that is Phase 1b.

### Phase 1b

- Added 7 `goal.*` wire record types; replay ignores them (state is from `state.json`).
- `SessionGoalStore` gained lazy `auditSink`, pending queue, `flushPendingRecords()`,
  `normalizeMetadata()`; every mutating method now appends its audit record.
- Session flushes pending goal records after the main agent exists (createMain + resume) and
  runs `normalizeMetadata()` after `readMetadata()` on resume (active → paused).
- `goal.account_usage` uses `usageKind: 'token' | 'wall_clock'`. 62 goal/records tests pass;
  full agent-core suite (2281) green; typecheck clean.

### Phase 2

- Added `goal-command` experimental flag (`KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND`, default off).
- `SessionAPI`/`CoreAPI` gained session-scoped `createGoal`/`getGoal`/`pauseGoal`/`resumeGoal`/
  `cancelGoal`/`clearGoal` (sessionId only, no agentId); core-api re-exports goal value types;
  `SessionAPIImpl` + `CoreImpl` delegate to `session.goals`.
- node-sdk: re-exported goal types; `SDKRpcClient` + `Session` forwarding methods (no public
  `updateGoal`).
- App: new `commands/goal.ts` deterministic parser + `handleGoalCommand`; registered behind
  `goal-command` with subcommand-aware availability; wired into dispatch/index.
- Tests: goal.test.ts (44 w/ registry+resolve), session-goal.test.ts (7). All typechecks pass;
  still no agent-core imports in app src.

### Detour note (Phase 2)

- The plan's SDK test direction ("forwards the right payload to SDKRpcClient") is implemented as a
  focused `Session`-with-stub-rpc unit test rather than a full harness round-trip, which is faster
  and directly asserts payload shape. Full end-to-end dispatch is covered in Phase 5.

### Phase 3

- Added `CreateGoalTool`/`GetGoalTool`/`UpdateGoalTool` under `tools/builtin/goal/` with `.md`
  descriptions and a shared main-agent/store guard. `UpdateGoal` records a model report (no
  direct terminal change). Errors converted to `isError` results with the typed code.
- `ToolManager.initializeBuiltinTools()` registers the three only when
  `flags.enabled('goal-command')` and `agent.type === 'main'`; profile `agent.yaml` lists them
  (subagent profiles do not).
- Tests: tools/goal.test.ts (registration gate via flag env + tool behavior), profile test.
  Full agent-core suite (2300) green; typecheck clean.

### Phase 4a

- Added `GoalInjector` (`agent/injection/goal.ts`, variant `goal`): injects only for an active
  goal (none/paused/terminal → no injection), wraps objective in `<untrusted_objective>` and
  completion criterion in `<untrusted_completion_criterion>`, shows status/progress/budgets with
  three threshold bands (<75% / 75–99% / ≥100%), plus model-report and evaluator context.
- `InjectionManager` adds it (after PluginSessionStart, before PlanMode) only when
  `goal-command` enabled and `agent.type === 'main'`, via an explicit push-ordered array.
- Test harness `testAgent` gained a `goals` option. Tests: injection/goal.test.ts (14) including
  the wire `context.append_message` record with `origin.variant === 'goal'`. Injection suite (33)
  green; typecheck clean.

### Phase 4b

- `TurnFlow` `afterStep` now records goal token usage (`grandTotal(usage)`, source `agent_step`,
  agent id derived from homedir basename) for every session agent step when an active goal exists.
  Comment `// Goal token budgets count every session agent step.` added.
- Token accounting is not flag-gated (a goal only exists via flag-gated paths anyway); the store's
  `recordTokenUsage` already no-ops for paused/terminal goals and writes no audit record then.
- Wall-clock accounting stays store-side (`recordWallClockUsage`); per the plan, the live
  per-continuation wall-clock recording + final-interval finalize hook land in Phase 4c.
- Tests added to turn.test.ts (42 pass): main + subagent token accounting, no-active-goal skip,
  token budget flag update without status change, paused skip, terminal-not-cleared, store
  wall-clock accumulation.

### Detour note (Phase 4b)

- The 4b plan also lists "subagent wall-clock does not update wallClockMs" and "superseded turn
  does not update final wall-clock". Those depend on the Phase 4c continuation controller /
  finalize hook (the only wall-clock writers from turns), so they are covered in Phase 4c, not 4b.

### Phase 4c

- Added `GoalContinuationController` (`agent/goal/continuation.ts`): per-turn state, injected
  clock, `lastWallClockAccountedAt` checkpoint; gated on flag + main + active goal. Decision
  order: stop if gone/paused/terminal → incrementTurn → record wall-clock → accept model report
  (complete/blocked/impossible) → hard-budget wrap-up → `maxStepsPerTurn` reconciliation →
  continue. Continuation/wrap-up prompts use `origin {kind:'system_trigger', name:'goal_continuation'}`.
  `markBudgetLimited` makes the goal terminal so the single wrap-up runs exactly once.
- `TurnFlow`: passes `startedAt` into the private `runTurn`, constructs the controller once,
  wraps the loop in `finally` to `finalizeWallClock()` (guarded by flag+main+turnId-owned+same
  goal). `shouldContinueAfterStop` order is now flush → external Stop hook (one continuation,
  uncapped for goals) → goal controller. Abnormal ends mark the active goal: aborted →
  `interrupted` (handled both on the normal `'aborted'` return and in the catch), failure →
  `error`, escaped `MaxStepsExceeded` → `budget_limited`. All main-agent + flag gated.
- Tests: goal-continuation.test.ts (20) — controller unit decisions + harness integration
  (auto-continue, subagent/flag-off no-continue, maxSteps→budget_limited, fail→error,
  cancel→interrupted, Stop-hook interplay). Full agent-core suite (2334) green; typecheck clean.

### Phase 4d

- Added `GoalEvaluator` (`agent/goal/evaluator.ts`): no-tool judge over a bounded conversation
  slice; strict-JSON verdict (`continue`/`complete`/`blocked`/`impossible`/`no_progress`) with
  balanced-brace JSON extraction; returns typed result + `usage`; typed error on bad JSON or a
  thrown call. Constructor seam (`{ llm }`) for a future lightweight judge.
- `GoalContinuationController` now runs the evaluator after the pre-eval budget check: counts
  evaluator tokens (`source: 'goal_evaluator'`), records the verdict, ends the goal on
  complete/blocked/impossible, re-checks budgets, enforces `noProgressTurnLimit` (→ blocked) and
  `failureTurnLimit` (→ error). The model self-report is now evidence for the evaluator, not a
  direct terminal signal.
- Store: added `recordEvaluatorFailure` (increments `consecutiveFailureTurns`, appends a
  `goal.evaluate` record with verdict `error`) — the Phase 1a deferred failure-increment path.
- Added `Agent.goalEvaluatorFactory` seam (threaded through `TurnFlow` and the test harness) so
  tests inject a fake judge deterministically.
- Tests: goal-evaluator.test.ts (24) — evaluator parsing/usage/errors + controller verdict
  behavior incl. two-step decide; updated goal-continuation.test.ts to inject fakes where the
  path now reaches the evaluator. Full agent-core suite (2351) green; typecheck clean.

### Detour note (Phase 4d)

- Added `recordEvaluatorFailure` to the store (not in the Phase 1a method list) to carry the
  consecutive-failure increment that 4d's `failureTurnLimit` needs; flagged in the Phase 1a notes.
- Added the `Agent.goalEvaluatorFactory` injection seam (production-default undefined → real
  `GoalEvaluator`) so harness integration tests don't have to interleave evaluator JSON into the
  scripted-model queue. This matches the plan's "constructor seam for a future judge model".

### Phase 5

- Added `test/harness/goal-session.test.ts` (4): full core flow on a real `Session` +
  `SessionAPIImpl` with a scripted model and a `vi.mock`'d evaluator — proves injection reaches
  the model, token accounting runs, `UpdateGoal` records a report without ending the goal, the
  evaluator confirms completion, terminal state persists in `state.json`, and
  `agents/main/wire.jsonl` carries goal.create/account_usage/continuation/report/evaluate/update.
  Plus turn-budget wrap-up, resume (active→paused), and user lifecycle controls.
- Added an app dispatch-level integration test: `dispatchInput(host, '/goal Ship feature X')`
  routes through the real resolver, creates the goal, and sends `Ship feature X` (not the raw
  command); flag-off routes it as a normal message.
- Export review: `SessionGoalStore`/`SessionGoalState`/`GoalContinuationController`/`GoalEvaluator`
  and `goal.*` payload types stay internal; only the public goal value types are re-exported
  (via core-api → agent-core index → node-sdk types); no public `Session.updateGoal`.
- Documented `KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND` (default off) + the master switch in
  `docs/en/configuration/env-vars.md`.
- Gates: full agent-core suite (2355) + app command suite (50) green; `pnpm run typecheck` OK
  across all packages; `pnpm run lint` OK (fixed an `eqeqeq` error introduced in 4b's accounting
  guard; remaining warnings are pre-existing repo-wide).

### Detour note (Phase 5)

- The plan's centerpiece harness test was built directly on the `Session` class (as `init.test.ts`
  does) with a scripted `generate`, rather than the full CoreAPI/RPC `createTestRpc` harness, and
  the evaluator is `vi.mock`'d so verdicts are deterministic without interleaving evaluator JSON
  into the model queue. This keeps the e2e flow readable and stable.

### Phase 6

- Headless goal mode: `apps/kimi-code/src/cli/goal-prompt.ts` (pure helpers — exit-code map,
  `/goal` create parser reusing `parseGoalCommand`, JSON/text summary) wired into
  `cli/run-prompt.ts`. `kimi -p "/goal <objective>"` (flag on) creates the goal, runs the turn
  (continuation runs inside it), then emits a summary and sets a distinct exit code
  (complete 0, error 1, blocked 3, impossible 4, budget_limited 5, interrupted 6, cancelled 7).
  Flag-off treats `/goal …` as an ordinary prompt. Resumed stale active goals are demoted to
  paused by the existing resume normalization.
- Tests: `test/cli/goal-prompt.test.ts` (9) — helper unit tests + `runPrompt` integration
  (create+summary, non-complete exit code, flag-off passthrough); added `getExperimentalFlags`
  to the existing run-prompt test harness mock. Hardening: `DEFAULT_GOAL_TURN_BUDGET` caps an
  always-continue evaluator (controller test); terminal `blocked` reason+evidence survive resume
  (harness test). Fixed an `afterEach` temp-dir cleanup race by closing sessions first.
- Gates: full agent-core suite (2357, stable across repeated runs) + app cli/commands (205)
  green; `pnpm run typecheck` + `pnpm run lint` OK.

### Hardening decisions (Phase 6 review)

- **SDK goal events**: deferred. Observability is covered by the `goal.*` audit wire records and
  `Session.getGoal()`; the headless path reads terminal status directly. A `goal.*` SDK event set
  is a clean follow-up but not required for the working interactive + headless feature.
- **Stale injected reminders**: accepted. `GoalInjector` is active-goal-gated, so replay of old
  `context.append_message` records restores history without producing a *new* reminder when no
  goal is active; each fresh reminder is a runtime snapshot. Dedupe/replace is a future refinement.
- **Repeated `goal_continuation` prompts**: accepted as real transcript history for now;
  compaction/dedupe deferred.
- **Vague-goal intake**: the TUI `/goal` path stays deterministic (Phase 2); model-assisted intake
  via `CreateGoal` remains available but is not auto-routed. Any switch would be a new phase.
- **Budget defaults**: `DEFAULT_GOAL_TURN_BUDGET = 20` remains the only default safety cap; no
  default token/wall-clock budgets added.
- **Evaluator model**: still the main-agent `llm` with a constructor seam
  (`Agent.goalEvaluatorFactory`) for a future lightweight judge.
- **Terminal snapshot retention & context-clear**: terminal goals persist until `/goal clear` or
  replacement; `/clear` (context) does not touch `metadata.custom.goal` — goal state is
  session-level, independent of agent context.

## Result

All 10 phases (1a–6) complete. Feature is behind `KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND`
(default off), documented in `docs/en/configuration/env-vars.md`.
