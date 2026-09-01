# Feature Specification: Fallback Model Cascade

**Feature Branch**: `827-fallback-model-cascade`

**Created**: 2026-09-01

**Status**: Draft

**Input**: User description: "add /fallback-model and /fallback-model-secondary that when after 10 tries fails it will first try /falback-model and if that does not work switch to /fallback-model-secondary we have similar implementation on squeeze-model and squeeze-model-secondary"

---

## Summary

When the primary model exhausts its retry budget (10 attempts) on a failed turn, the agent should automatically cascade to a configured `/fallback-model`, and if that also fails, to `/fallback-model-secondary`. This mirrors the existing compaction-model cascade (`squeeze-model` → `squeeze-model-secondary` → current model) but applies to the main agent loop.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Configure a fallback model (Priority: P1)

A user wants to set a fallback model so that when the primary model repeatedly fails, the agent automatically retries on the fallback model instead of giving up.

**Why this priority**: Core value — without this, failed turns end in an unrecoverable error when the primary model is unhealthy.

**Independent Test**: Set `/fallback-model` to an alias, restart a turn that fails on the primary model, and observe the agent retries on the fallback model.

**Acceptance Scenarios**:

1. **Given** the user runs `/fallback-model <alias>`, **When** the primary model exhausts its retry budget, **Then** the agent retries the turn on the fallback model before failing.
2. **Given** no fallback model is configured, **When** the primary model exhausts its retry budget, **Then** the agent behaves exactly as before (fails the turn).

---

### User Story 2 - Configure a secondary fallback model (Priority: P2)

A user wants a second fallback tier so the cascade is: primary → fallback-model → fallback-model-secondary → error.

**Why this priority**: Extends resilience; avoids a single-point-of-failure in the fallback path.

**Independent Test**: Set both `/fallback-model` and `/fallback-model-secondary`, trigger a primary-model failure, and confirm the cascade reaches the secondary fallback before failing.

**Acceptance Scenarios**:

1. **Given** both `/fallback-model` and `/fallback-model-secondary` are configured, **When** the primary model and the fallback model both exhaust retries, **Then** the agent retries on the secondary fallback model.
2. **Given** only `/fallback-model` is configured, **When** the primary model exhausts retries, **Then** the agent uses `/fallback-model` and does not attempt any secondary fallback.

---

### User Story 3 - Fallback model persists across sessions (Priority: P2)

The fallback model configuration should persist in `[fallback_model]` config section and survive restarts.

**Why this priority**: Users expect configuration to be durable.

**Independent Test**: Run `/fallback-model <alias>`, restart the application, and verify the alias is still configured.

**Acceptance Scenarios**:

1. **Given** `/fallback-model <alias>` is saved, **When** the application restarts, **Then** the alias is still read from `[fallback_model] model`.
2. **Given** `/fallback-model-secondary <alias>` is saved, **When** the application restarts, **Then** the alias is still read from `[fallback_model] secondary_model`.

---

### User Story 4 - Fallback model appears in model pickers (Priority: P3)

When selecting a fallback model via the picker UI, the list should show available models.

**Why this priority**: Consistency with existing `/squeeze-model` picker UX.

**Acceptance Scenarios**:

1. **Given** the user triggers the fallback-model picker, **When** the picker opens, **Then** it shows the same model list as other model pickers.

---

### Edge Cases

- What happens when the fallback model alias does not exist in the known models list? The cascade should skip it and proceed to the next tier.
- How does the system handle the fallback model itself failing after its own retry budget? The cascade proceeds to the secondary fallback, then errors out.
- What if both fallback models are the same alias? The secondary fallback is skipped (no-op) after the first fallback fails.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST add a `[fallback_model]` config section with `model` (string) and `secondary_model` (string) fields.
- **FR-002**: The `/fallback-model` slash command MUST persist the chosen alias into `[fallback_model] model` and enable the `fallback-model` experiment flag.
- **FR-003**: The `/fallback-model-secondary` slash command MUST persist the chosen alias into `[fallback_model] secondary_model`.
- **FR-004**: After the primary model exhausts its retry budget (10 attempts by default), the agent loop MUST try the `fallback_model.model` alias before surfacing a terminal error.
- **FR-005**: If `fallback_model.model` also exhausts its retry budget, the agent loop MUST try `fallback_model.secondary_model` before surfacing a terminal error.
- **FR-006**: If no fallback model is configured, the agent MUST behave identically to the current behavior on primary-model failure.
- **FR-007**: The fallback model cascade MUST be independent of the compaction-model cascade; it applies to the main agent loop, not context summarization.
- **FR-008**: The `/fallback-model` and `/fallback-model-secondary` commands MUST be available via Tab autocompletion.
- **FR-009**: If the configured fallback alias is unknown or unavailable, the cascade MUST skip it and proceed to the next tier.

### Key Entities

- **`[fallback_model]`**: Config section holding the fallback model cascade (`model` + `secondary_model`).
- **`fallback_model.model`**: The first-tier fallback alias; tried after the primary model exhausts retries.
- **`fallback_model.secondary_model`**: The second-tier fallback alias; tried after the first fallback exhausts retries.
- **Fallback model cascade**: The retry chain in the agent loop: primary model → `fallback_model.model` → `fallback_model.secondary_model` → terminal error.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: When the primary model fails 10 times, the agent retries on the configured fallback model at least once before returning an error.
- **SC-002**: Both `/fallback-model` and `/fallback-model-secondary` commands complete in under 2 seconds from invocation to status display.
- **SC-003**: The fallback model configuration persists across application restarts (read back from `[fallback_model]` section).
- **SC-004**: No existing retry, compaction, or substitute-model behavior is broken when fallback models are unset.
- **SC-005**: Tab autocompletion for `/fallback-model` and `/fallback-model-secondary` returns the same model list as other model commands.

---

## Assumptions

- The retry budget of 10 attempts is the existing default (`DEFAULT_MAX_RETRY_ATTEMPTS`); no new retry limit is introduced for the fallback tier — each fallback tier uses the same retry budget as the primary model.
- The `fallback-model` experiment flag gates the feature off by default, similar to `compaction-model`, so existing behavior is preserved until the user explicitly enables it.
- The fallback cascade lives in the same `AgentStepRetryService` or a new `FallbackModelService` that wires into the existing loop error handler.
- The slash command registration follows the existing `handleSqueezeModelCommand` / `handleSqueezeModelSecondaryCommand` pattern in `apps/kimi-code/src/tui/commands/config.ts`.
- The config section registration follows the existing `registerConfigSection` pattern in `packages/agent-core-v2/src/app/kosongConfig/configSection.ts`.
- The spec only covers the main agent loop; sub-agents and swarm tasks use the same fallback configuration.

---

## Notes

- This feature is a direct analog of the `compaction_model` cascade but for the main model loop. Reuse the same patterns: `registerConfigSection`, `resolve*` functions, slash commands with a model picker, and the same experiment-flag gating.
- The existing `DEFAULT_MAX_RETRY_ATTEMPTS = 10` constant is the retry budget per tier; the cascade treats each tier independently.
- The implementation should avoid adding new external dependencies; all building blocks (config section, slash commands, retry service) already exist in the codebase.
