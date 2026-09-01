# Research: Fallback Model Cascade

**Feature**: 009-fallback-model-cascade
**Date**: 2026-09-01

## Decision: Add new config section `[fallback_model]` parallel to `[compaction_model]`

**Rationale**: The existing `[compaction_model]` section already implements a model cascade (primary → secondary → caller) for context summarization. The fallback-model cascade applies the same pattern to the main agent loop. Mirroring the existing shape minimizes new surface area and reuses established patterns.

**Alternatives considered**:
- Extending the existing `[compaction_model]` section with fallback fields — rejected because compaction and fallback are independent concerns with different experiment flags.
- Reusing the existing `[substitute_model]` section — rejected because substitute is for rate-limit cooldown, not full retry-budget exhaustion.
- Inline model list on the agent config — rejected because it would diverge from the established per-concern section model.

## Decision: Wire cascade into `AgentStepRetryService` after the existing `recover` flow

**Rationale**: The retry service already tracks `failedAttempts` against `DEFAULT_MAX_RETRY_ATTEMPTS` (10) and dispatches a final `false` return once exhausted. Inserting a fallback attempt after the budget is exhausted is the natural extension point and preserves all existing backoff, error reporting, and event emission behavior.

**Alternatives considered**:
- Adding a new dedicated `FallbackModelService` — considered but rejected; the existing `AgentStepRetryService` already owns the right lifecycle and can be extended with a `tryFallback` method.
- Reusing the substitute-model cooldown mechanism — rejected; substitute handles rate-limit cooldown, not full retry-budget exhaustion.

## Decision: Each fallback tier reuses the same `DEFAULT_MAX_RETRY_ATTEMPTS` budget (10)

**Rationale**: Spec FR-004 / FR-005 say "after 10 tries fails" — the user expectation is symmetric across tiers. Reusing the existing constant means no new tuning knobs and predictable behavior.

**Alternatives considered**:
- A per-tier budget (e.g., 5 for primary, 3 for fallback) — rejected; the spec uses the same 10 for every tier.
- An infinite retry on fallback — rejected; the spec is explicit about 10 attempts per tier.

## Decision: Gate behind a `fallback-model` experiment flag

**Rationale**: The `[compaction_model]` cascade uses the same pattern (`compaction-model` experiment). Following it keeps flag-driven opt-in and lets the resolver short-circuit to the existing behavior while the flag is off.

**Alternatives considered**:
- Always-on — rejected; would change existing behavior for users who don't opt in.
- A separate `fallback-model-secondary` flag — rejected; one flag is enough for the entire cascade.

## Decision: Slash command pattern mirrors `handleSqueezeModelCommand` / `handleSqueezeModelSecondaryCommand`

**Rationale**: Both squeeze and fallback use a TabbedModelSelectorComponent, the same `perform*Save` async persistence, the same experiment-flag enable on save, and the same status-message shape. Reusing the exact pattern minimizes risk and keeps the UX consistent.

**Alternatives considered**:
- A single `/fallback-model <primary> <secondary>` command — rejected; two separate commands are easier to discover and tab-complete.
- A subcommand syntax (`/fallback-model set primary ...`) — rejected; the existing pattern uses bare slash commands.
