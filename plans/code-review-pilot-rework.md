# Code Review — Perspective → Main-Agent Pilot Rework

Status: **planned, not started.** Design converged. Companion to
`code-review-conversation-persistence.md` (this rework resolves it) and
`code-review-command-design.md` (this restores its original "main agent chooses
the review angles" intent, which the implementation had shortcut into hardcoded
perspective lists).

## Goal

Replace the hardcoded, user-facing review *perspectives* with a **pilot review
done by the literal main conversation agent**, driven by the harness as an
explicit, fully-persisted multi-step exchange:

1. The main agent inspects the selected diff, concludes the **change type**, and
   produces a **background** (a briefing for reviewers, written from the agent's
   knowledge) plus a few focused **directions** (review angles).
2. The agent calls a new `RunCodeReview` tool; its arguments fan out to fresh
   reviewer sub-agents (the existing reviewer/reconciliator machinery).
3. Directions are shown to the user **read-only** — no menu, no choosing, no
   editing — and the review auto-continues.

All three intensities (standard, thorough, deep) run the pilot.

## Why

- The baked-in `THOROUGH_REVIEW_PERSPECTIVES` / `DEEP_REVIEW_PERSPECTIVES` lists
  are generic and were shown to the user as a confirmation dialog they couldn't
  act on.
- Perspectives were the axis that made parallel reviewers *non-redundant*. A
  diff-derived pilot keeps that non-redundancy while removing the hardcoded list
  and the user-facing choice.
- Using the **literal main agent** (not a fresh scout sub-agent) means the pilot
  has the conversation context — it knows what was just built — so it can hand
  reviewers a real **background**. The reviewers themselves stay fresh/unbiased.

## The workflow (the core design)

Everything is a **real, persisted conversation record** — there is no ephemeral
"seeded context" that gets discarded on resume. The harness drives two turns:

| Step | Actor | Persisted record |
|---|---|---|
| 1. User picks **instruction** (focus) + **mode** (scope) + **intensity** | TUI pickers | No — UI selection only |
| 2. Harness asks the agent to run a pilot review for this instruction + mode, including the resolved scope and a diff summary | Harness → agent message (turn 1 prompt) | **Yes** — instruction/mode/intensity enter the conversation here |
| 3. Agent reads the diff and produces background + directions | Agent reply (turn 1) | **Yes** (pilot reasoning) |
| 4. Harness asks the agent to call `RunCodeReview`, with the guidance for how to run the fan-out | Harness → agent message (turn 2 prompt) | **Yes** |
| 5. Agent calls `RunCodeReview(background, directions, target, intensity)` → reviewers fan out → consolidated result | Tool call + tool result (turn 2) | **Yes** — persists + replays + the LLM sees it |

Notes:
- **Two harness messages = two turns.** Turn 1 is the pilot; turn 2 is the
  fan-out. Step 4 is separate because the harness supplies *additional guidance*
  for the review round there. The agent calls `RunCodeReview` in turn 2 using the
  background/directions it concluded in turn 1 (same conversation, so it's in
  context).
- The harness messages (steps 2, 4) are agent-directed instructions
  (system/developer role). Whether they render to the user or are quiet chrome is
  a display detail (see Open items).
- This **supersedes the earlier "seed vs hidden-RPC" debate** — step 2 *is* the
  entry and it's an ordinary record.

## The `RunCodeReview` tool

A new builtin modeled on `AgentSwarmTool`
(`tools/builtin/collaboration/agent-swarm.ts`), registered in
`agent/tool/index.ts`. Available to the **main agent** (not gated on
`agent.review`; it needs `subagentHost`, like AgentSwarm).

**Arguments (all agent-supplied — the call is self-contained and self-describing
in the record):**

```jsonc
{
  // Pilot's briefing for reviewers, from the agent's knowledge: what the change
  // is, its intent, the context needed to judge it. Factual orientation, NOT a
  // verdict (don't tell reviewers it's correct). When the user gave an
  // instruction, write the background through that lens. Required.
  "background": string,

  // Review angles; each becomes one reviewer's perspective (fills
  // ReviewAssignment.perspective). Required, 1–6; ≥2 when intensity is "deep".
  // If the user gave an instruction, lead with / derive from it.
  "directions": string[],

  // Scope descriptor: working_tree | current_branch (+ baseRef) |
  // single_commit (+ commit). The tool re-resolves the diff from git and
  // validates. Required.
  "target": ReviewTarget,

  // standard | thorough | deep. Required.
  "intensity": ReviewIntensity,

  // Short label for the compact header, e.g. "TUI refactor". Optional.
  "change_type"?: string
}
```

- The user's **instruction** is not an arg — it lives in the step-2 message
  (verbatim, authoritative, persisted) and is reflected by the pilot in
  `background` (as a lens) and `directions` (as the lead). The reviewers receive
  the verbatim instruction via `ReviewBackground.focus` as today.
- The tool runs the reviewers on **its arguments** — that is simply how the tool
  works; nothing reads the step-3 prose. So there is no "source of truth" to
  reconcile: the args are what runs, and the read-only directions panel renders
  from the args at fan-out start.
- `execute()` builds `ReviewOrchestrator` with `runtime = session.review`,
  `launcher = mainAgent.subagentHost`, `parentToolCallId = context.toolCallId`,
  `signal = context.signal`, feeding the `directions` as the fan-out angles and
  `background` into the reviewers' `ReviewBackground`; returns the `ReviewResult`;
  performs `persistReviewResult`.
- **Validation:** `directions` non-empty; `directions.length ≥ 2` for deep.

## Design calls (kept from discussion)

- **Pilot mechanism:** the real `RunCodeReview` tool the agent actually calls —
  not a synthetic/faked tool record. The agent's pilot is genuine model output.
- **Internal naming:** keep the internal `perspective` field; only change what
  *fills* it (pilot directions, not hardcoded lists). A full
  `perspective`→`direction` rename touches ~10 files plus the persisted event
  shape — not worth it. Only user-facing strings/labels change.
- **Background guardrail:** factual orientation, not a verdict — preserve
  reviewer independence.
- **Instruction handling:** verbatim + authoritative in the step-2 message and
  `ReviewBackground.focus`; lensed into `background`; leads the `directions`.
- **Read-only safety (v1):** the pilot runs in an ordinary main-agent turn with
  full tools; constrain it via the step-2/step-4 prompts ("inspect and fan out;
  do not modify files"). Do not put the main agent into review-mode. Reviewer
  sub-agents stay read-only-guarded as today. A turn-scoped "pilot mode" deny
  policy is post-v1.

## Persistence (resolved)

Because all five steps are real records, resume is non-empty and the agent sees
the review — the two failures in `code-review-conversation-persistence.md` are
resolved with no special record kind. The one piece that still needs work is
**rendering the colored compact block on replay**: carry the
`ReviewSummaryTranscriptData` alongside the tool result and add a `RunCodeReview`
tool-result renderer that draws the block live and on replay. Rejection records
as conversation messages are deferred.

## Open / minor items

- **Harness message rendering** (steps 2, 4): rendered as lightweight status, or
  hidden chrome? Display detail; pick during P3.
- **Intensity escalation:** v1 keeps `intensity` as the user's pick passed
  through. Letting the pilot *recommend* escalating (e.g. "this is risky, bump to
  deep") is a later option.
- **Tool gating:** `RunCodeReview` is a normal builtin the agent could in
  principle call outside `/review`. v1 relies on the harness driving it; consider
  gating availability to an active review later.
- `change_type` is optional (can be the first line of `background`).

## Phases

- **P0 — Spike:** prove tool-result → record → replay renders the review payload
  (throwaway test). Fix payload shape: inline compact summary
  (`ReviewSummaryTranscriptData` from `buildReviewSummaryData`) + `reviewId` /
  `reviewSlug` pointer.
- **P1 — Remove hardcoded perspectives + thread dynamic directions** (invariant
  to the entry rework — safe to land first). `prompts.ts`: delete
  `THOROUGH_REVIEW_PERSPECTIVES`; reviewer prompt builders already read
  `assignment.perspective`. `coverage-matrix.ts`: delete the
  `DEEP_REVIEW_PERSPECTIVES` default; require `perspectives` (from directions) for
  deep; keep the ≥2 guard. `orchestrator.ts`: `runThoroughReview` /
  `runDeepReview` source angles from `context.input.directions`;
  `buildDeepReviewAgentSwarmEvent` carries directions; delete
  `buildReviewPlanPreview` + preview-plan plumbing. `types.ts`: add `directions`
  to `ReviewStartInput`/context; keep `ReviewAssignment.perspective`. TUI:
  `review-swarm-progress.ts` maps letters/labels over N directions (verify
  `perspectiveLetter` handles > 4); `review-options.ts` drop
  `THOROUGH_REVIEW_PERSPECTIVE_LABELS`; `review.ts` drop `reviewPlanSummary` +
  `promptReviewPerspectiveConfirmation`.
- **P2 — `RunCodeReview` tool:** new builtin (above). `execute()` runs the
  orchestrator fan-out with the args; moves `persistReviewResult` here.
  New `tools/builtin/review/run-code-review.ts` (+ `.md`). Register in
  `agent/tool/index.ts`.
- **P3 — Harness-driven two-turn entry + read-only directions.** `review.ts`
  keeps the scope + intensity pickers; removes the perspective-confirmation
  dialog. Drive turn 1 (pilot prompt incl. resolved scope + diff summary +
  instruction) and turn 2 (fan-out guidance prompt). Remove the `hasActiveTurn`
  throw and the out-of-band `startReview` RPC; concurrency is ordinary turn
  queue/steer; cancellation = turn cancel → `subagentHost.cancelAll`. Emit
  `review.started` with `directions`/`change_type` at fan-out start; render
  read-only in `session-event-handler.ts handleReviewStarted` (no dialog,
  auto-continue). Files: `review.ts`, `session/index.ts` (~510–558),
  `node-sdk/src/session.ts`, RPC defs, `agent/turn/index.ts`, `prompts.ts`
  (pilot + fan-out prompt builders).
- **P4 — Persistence/rendering:** `RunCodeReview` tool-result renderer for the
  colored block live + on replay (`tool-renderers/review.ts`); carry
  `ReviewSummaryTranscriptData` in the result. Retire the ephemeral
  `review-summary` transcript entry for fresh reviews (keep for the `/review
  read` browsed-note path).
- **P5 — Tests:** update `orchestrator-thorough/deep`, `coverage-matrix`,
  `prompts`, `session/review`, `review-options`, `review.test`/`review-command`,
  `session-event-handler-review` (directions payload). New: `RunCodeReview`
  (validation; `parentToolCallId = toolCallId`; cancellation via
  `context.signal`), pilot → fan-out direction threading, and a replay test
  (review survives reopen, colored block intact, agent has it in context).

## Risks / cut-line

- The two-turn harness orchestration (driving turn 1, waiting, driving turn 2) is
  the trickiest part of P3 — verify the harness reliably detects turn-1
  completion before sending turn 2.
- Verify swarm-progress letters extend past 4 directions.
- Confirm `ReviewPlanPreview` has no other consumer before deleting it.
- Test that cancellation reaches the orchestrator before `runQueued` spawns, so
  no orphan reviewers are left running.

## End-to-end verification

Unit: `test/review/*`, `test/session/review.test.ts`, the TUI review suites, the
new tests, and the replay test.

Manual: in a repo with changes, `/review focus on the auth flow` → Working tree →
Standard. Confirm: no "Review perspectives" dialog; the agent pilots; derived
directions shown read-only; review auto-continues; colored compact block renders;
`/review read` opens the fullscreen reader; ask the agent "fix the first comment"
and confirm it has the review in context; reopen the session and confirm the
block + agent context survive replay; press Esc mid-review for a clean cancel.
Repeat for Thorough and Deep to exercise multi-direction fan-out and the
swarm-progress letters.
