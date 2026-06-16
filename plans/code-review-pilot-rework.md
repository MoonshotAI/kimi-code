# Code Review — Perspective → Main-Agent Pilot Rework

Status: **planned, not started.** Two scope forks (D1, D2) must be confirmed
before implementation. Companion to `code-review-conversation-persistence.md`
(this rework resolves it) and `code-review-command-design.md` (this restores its
original "main agent chooses perspectives" intent, which the implementation had
shortcut into hardcoded lists).

## Goal

Replace the hardcoded, user-facing review *perspectives* with a **pilot review
done by the literal main conversation agent**:

1. The main agent inspects the selected diff, concludes the **change type**, and
   derives a few focused **review directions** (elaborating the user's free-form
   `focus` if one was given).
2. Those directions fan out to fresh reviewer sub-agents (the existing
   reviewer/reconciliator machinery).
3. Directions are shown to the user **read-only** — no menu, no choosing, no
   editing — and the review auto-continues.

All three intensities (standard, thorough, deep) run the pilot.

## Why

- The baked-in `THOROUGH_REVIEW_PERSPECTIVES` / `DEEP_REVIEW_PERSPECTIVES` lists
  are generic and shown to the user as a confirmation dialog they can't act on.
- Perspectives were the axis that made parallel reviewers *non-redundant* (each
  looked at one angle). A diff-derived pilot keeps that non-redundancy while
  removing the hardcoded list and the user-facing choice.
- Using the **literal main agent** (not a fresh scout sub-agent) means the pilot
  has the conversation context — it knows what was just built — which produces
  better-targeted directions. The reviewers themselves stay fresh/unbiased.

## The core architectural shift

Today `/review` runs **out-of-band**:
`tui/commands/review.ts` → `session.startReview()` (RPC) →
`agent-core/session/index.ts` `startReview()` — which **throws if
`hasActiveTurn`** — then runs `ReviewOrchestrator`, which spawns reviewer /
reconciliator sub-agents directly via `mainAgent.subagentHost`. The main agent
is never involved, and **no conversation record is produced** (empty resume; the
agent can't "see" the review).

To let the literal main agent do the pilot, **`/review` becomes a real
main-agent turn**:

```
/review <focus>
  → TUI resolves scope + intensity (deterministic pickers, kept)
  → seed a main-agent turn: "pilot-review this diff, derive directions, then
    call RunReviewers"
  → main agent inspects diff (stats), classifies, derives directions  [PILOT]
  → main agent calls RunReviewers(directions, intensity)              [TOOL CALL]
      → tool runs the existing orchestrator fan-out (reviewers + reconcilers)
      → returns the consolidated ReviewResult as the tool result
  → tool result = LoopToolResultEvent → persisted context.append_loop_event
    record → persists + replays + the LLM sees it                     [FREE]
```

This resolves `code-review-conversation-persistence.md` (option 1: review as a
tool call within a turn).

## Open decisions (confirm before building)

- **D1 — Seed transport.** Dedicated hidden-seed RPC (`startReviewTurn`, an
  invisible structured seed carrying target/intensity/stats; cleaner UX, more
  work) **vs** `session.prompt()` with a visible-ish seed string (lighter, but a
  faint seed line appears in chat). _Recommend the dedicated RPC; `prompt()` is
  the smaller-v1 fault line._
- **D2 — Persistence bundling.** Review-as-turn resolves persistence as a side
  effect. Confirm we want that folded into this change now vs. a lighter first
  cut that defers the replay/rendering polish.

## Design calls (lower-risk defaults)

- **Pilot mechanism:** the main agent calls `RunReviewers` **directly with
  `directions[]` in its args**. The pilot "reasoning" is just the agent's
  chain-of-thought before the call; the directions persist as tool args. No
  separate `ProposeReviewDirections` tool (it would add a second record and an
  ordering problem — what if the agent proposes but never fans out?).
- **Internal naming:** **keep the internal `perspective` field**; change only
  what *fills* it. Pilot directions populate `ReviewAssignment.perspective`
  instead of the hardcoded lists. A full `perspective`→`direction` rename touches
  ~10 files plus the persisted event shape — not worth the risk. Only
  user-facing strings/labels change.
- **Pilot diff inspection (v1):** feed diff **stats** (file list, statuses, +/−
  counts, already in `preview.stats`) into the seed prompt; the pilot classifies
  from that plus `focus`. Defer line-level diff reading by the main agent —
  reviewers still read deeply.
- **Read-only safety (v1):** constrain the pilot via the seed prompt ("inspect
  and fan out; do not modify files"). Do **not** put the main agent into
  review-mode (it would break the agent's normal tooling and the fan-out tool
  itself). Reviewer sub-agents remain read-only-guarded as today. A turn-scoped
  "pilot mode" deny policy is post-v1.

## Phases

### P0 — Contracts / spike
Prove the tool-result → record → replay path renders the review payload with a
throwaway replay test. Fix the tool-result payload shape: **inline compact
summary** (`summary` + the existing `ReviewSummaryTranscriptData` from
`buildReviewSummaryData`) **plus a `reviewId` / `reviewSlug` pointer** to the
durable artifact.

### P1 — Entry rework
Keep the scope + intensity pickers in the TUI (cheap git queries, good UX).
**Remove** `promptReviewPerspectiveConfirmation` and the `previewReviewPlan`
call. Launch a main-agent turn (per D1) seeded with target + intensity + diff
stats + verbatim `focus`. Remove the `hasActiveTurn` throw — concurrency is now
ordinary turn queue/steer. Move `reviewStartInFlight` / `activeReviewOrchestrator`
/ `cancelReview` into the tool execution; cancellation becomes ordinary turn
cancel (`turn.cancel` → `subagentHost.cancelAll`).
Files: `tui/commands/review.ts`, `agent-core/session/index.ts` (~510–558),
`node-sdk/src/session.ts`, the RPC definitions, `agent-core/agent/turn/index.ts`.

### P2 — `RunReviewers` fan-out tool
New builtin modeled on `AgentSwarmTool`
(`tools/builtin/collaboration/agent-swarm.ts`), registered in
`agent/tool/index.ts`. **Not** gated on `agent.review` (it needs `subagentHost`,
like AgentSwarm). Input schema: `directions: string[]` (≥1; ≥2 for deep),
`intensity`, optional `change_type`; the target is resolved from turn-scoped
review context set at seed time (so the agent can't review a different target).
`execute()` builds `ReviewOrchestrator` with `runtime = session.review`,
`launcher = mainAgent.subagentHost`, `parentToolCallId = context.toolCallId`,
`signal = context.signal`, feeding the pilot `directions`; returns the
`ReviewResult`; moves `persistReviewResult` here.
New files: `tools/builtin/review/run-reviewers.ts` (+ `.md`).

### P3 — Pilot inspection + read-only surfacing
Add `buildReviewPilotSeedPrompt` in `review/prompts.ts`. Emit `review.started`
with `directions` + `changeType`; render them read-only in
`tui/controllers/session-event-handler.ts` `handleReviewStarted` — no dialog,
auto-continue.

### P4 — Remove hardcoded perspectives
- `review/prompts.ts`: delete `THOROUGH_REVIEW_PERSPECTIVES`.
  `buildThoroughReviewerPrompt` / `buildDeepReviewerPrompt` already read
  `assignment.perspective` — only the callers change.
- `review/coverage-matrix.ts`: delete the `DEEP_REVIEW_PERSPECTIVES` default;
  make `perspectives` required for deep (sourced from directions); keep the
  `MIN_REVIEWERS_PER_FILE` (≥2) guard.
- `review/orchestrator.ts`: `runThoroughReview` maps over
  `context.input.directions`; `runDeepReview` passes `perspectives: directions`
  to `createDeepCoverageMatrix`; `buildDeepReviewAgentSwarmEvent` carries
  directions; delete `buildReviewPlanPreview` + preview-plan plumbing once
  unused.
- `review/types.ts`: add `directions` to `ReviewStartInput` / orchestrator
  context; remove `ReviewPlanPreview` / `ReviewPlanFileGroup` if the preview path
  is deleted; **keep** `ReviewAssignment.perspective`.
- TUI: `components/messages/review-swarm-progress.ts` letter/label maps over N
  directions (verify `perspectiveLetter` handles > 4);
  `utils/review-options.ts` drop `THOROUGH_REVIEW_PERSPECTIVE_LABELS`;
  `commands/review.ts` drop `reviewPlanSummary` + `promptReviewPerspectiveConfirmation`.

### P5 — Persistence / rendering
Carry `ReviewSummaryTranscriptData` alongside the tool result; add a
`RunReviewers` **tool-result renderer**
(`components/messages/tool-renderers/review.ts`) that draws the colored compact
block both live and on replay. Retire the ephemeral `review-summary` transcript
entry for fresh reviews (keep it for the `/review read` browsed-note path).
Defer rejection-as-conversation-records.

### P6 — Tests
Update: `test/review/orchestrator-thorough.test.ts`,
`orchestrator-deep.test.ts`, `coverage-matrix.test.ts`, `prompts.test.ts`,
`test/session/review.test.ts`, `tui/review-options.test.ts`,
`tui/commands/review.test.ts` / `review-command.test.ts`,
`session-event-handler-review.test.ts` (directions payload).
New: `RunReviewers` tool (validation; `parentToolCallId = toolCallId`;
cancellation via `context.signal`), pilot → fan-out direction threading, and a
replay test (review survives session reopen, colored block intact, agent has it
in context).

## Risks / cut-line

- Turn-entry + persistence is where scope balloons (D1 / D2). **Smaller v1:**
  ship P1–P6 with the `session.prompt()` seed + diff-stats pilot + inline summary
  renderer; defer the dedicated RPC, the pilot-mode policy, and
  rejection-as-records.
- Verify the swarm-progress letters extend past 4 directions.
- Confirm `ReviewPlanPreview` has no other consumer before deleting it.
- Test that cancellation reaches the orchestrator before `runQueued` spawns, so
  no orphan reviewers are left running.

## End-to-end verification

Unit: `test/review/*`, `test/session/review.test.ts`, the TUI review suites, the
new tests, and the replay test.

Manual: in a repo with changes, `/review focus on the auth flow` → Working tree
→ Standard. Confirm: no "Review perspectives" dialog; derived directions shown
read-only; review auto-continues; colored compact block renders; `/review read`
opens the fullscreen reader; ask the agent "fix the first comment" and confirm it
has the review in context; reopen the session and confirm the block + agent
context survive replay; press Esc mid-review for a clean cancel. Repeat for
Thorough and Deep to exercise multi-direction fan-out and the swarm-progress
letters.
