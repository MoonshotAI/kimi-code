# Feature Specification: Session-Specific Model Pickers

**Feature Branch**: `829-session-model-picker`

**Created**: 2026-09-01

**Status**: Draft

**Input**: User description: "when we select mode using /model we have this Shift + S command that chooses the model for session only. this same behaviour should be implemented on / commands with a model selector. squeeze, secondary, fallback etc make sure to check all model selector slash commands and all have the ability to choose session specific models for each model"

---

## Summary

Add session-specific model selection to every model-picker slash command. The `/model` command already supports Shift+S to pick a model for the current session only; the same `onSessionOnlySelect` capability must be wired through to `/squeeze-model`, `/squeeze-model-secondary`, `/substitute-model`, `/visual-model`, `/secondary-model`, `/fallback-model`, and `/fallback-model-secondary`.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Session-specific squeeze model via Shift+S (Priority: P1)

A user wants to temporarily override the compaction model for the current session without changing their default squeeze model setting.

**Why this priority**: The squeeze model is the most commonly tuned model-specific config; temporary overrides are a frequent need.

**Independent Test**: Open the `/squeeze-model` picker, press Shift+S, select a model, and confirm the session uses that model for compaction while the global `[compaction_model] model` setting remains unchanged.

**Acceptance Scenarios**:

1. **Given** the user opens the `/squeeze-model` picker and presses Shift+S, **When** they select a model, **Then** that model is applied to the current session only and the default `[compaction_model] model` is not modified.
2. **Given** the user opens `/squeeze-model` and presses Enter (not Shift+S), **When** they select a model, **Then** the existing persistent save behavior (`performSqueezeModelSave`) runs unchanged.

---

### User Story 2 - Session-specific secondary squeeze model (Priority: P2)

A user wants to temporarily set the secondary fallback for compaction on a per-session basis.

**Why this priority**: Secondary fallback is used less often, but the same session override pattern applies.

**Acceptance Scenarios**:

1. **Given** the user opens `/squeeze-model-secondary` and presses Shift+S, **When** they select a model, **Then** that model is applied to the current session only without modifying `[compaction_model] secondary_model`.

---

### User Story 3 - Session-specific substitute model (Priority: P2)

A user wants to try a substitute model for rate-limit fallback in one session without committing it globally.

**Why this priority**: Rate-limit situations are common; users may want to test whether an alternative provider works better in the current session.

**Acceptance Scenarios**:

1. **Given** the user opens `/substitute-model` and presses Shift+S, **When** they select a model, **Then** the session uses that model as its substitute without modifying `[substitute_model] default_model`.

---

### User Story 4 - Session-specific visual model (Priority: P3)

A user wants to use a different visual model for the current session's image inspection tasks.

**Acceptance Scenarios**:

1. **Given** the user opens `/visual-model` and presses Shift+S, **When** they select a model, **Then** the session uses that visual model without modifying `[visual_model] model`.

---

### User Story 5 - Session-specific secondary model (subagent pool) (Priority: P3)

A user wants a different secondary model for subagents in the current session only.

**Acceptance Scenarios**:

1. **Given** the user opens `/secondary-model` and presses Shift+S, **When** they select a model, **Then** the session uses that model as its secondary model without modifying `[secondary_model] default_model`.

---

### User Story 6 - Session-specific fallback model (Priority: P2)

A user wants to test a fallback model for the current session without committing it globally.

**Acceptance Scenarios**:

1. **Given** the user opens `/fallback-model` and presses Shift+S, **When** they select a model, **Then** the session uses that model as the first-tier fallback without modifying `[fallback_model] model`.

---

### User Story 7 - Session-specific fallback secondary model (Priority: P3)

A user wants to test a second-tier fallback model for the current session.

**Acceptance Scenarios**:

1. **Given** the user opens `/fallback-model-secondary` and presses Shift+S, **When** they select a model, **Then** the session uses that model as the second-tier fallback without modifying `[fallback_model] secondary_model`.

---

### Edge Cases

- If `onSessionOnlySelect` is not provided, the picker must still work normally with only `onSelect` (backward-compatible — existing behavior unchanged).
- The session-only selection must not persist to `config.toml` or any config store.
- After a session-only selection, the picker should close and show a status message indicating the session-only scope (e.g., "Squeeze model set to X for this session only").
- The Shift+S hint must appear in the picker's key-hint line when `onSessionOnlySelect` is provided, consistent with the `/model` picker behavior.
- If the same model is selected both persistently and session-only, the session override takes precedence for the current session while the default remains unchanged.

---

## Requirements *(mandatory)*

- **FR-001**: Every model-picker slash command (`/squeeze-model`, `/squeeze-model-secondary`, `/substitute-model`, `/visual-model`, `/secondary-model`, `/fallback-model`, `/fallback-model-secondary`) MUST accept `onSessionOnlySelect` in its `TabbedModelSelectorComponent` options.
- **FR-002**: When Shift+S is pressed in any of those pickers, the selected model MUST be applied to the current session only without modifying the global config.
- **FR-003**: The persistent `onSelect` behavior MUST remain unchanged — pressing Enter still saves to the global config.
- **FR-004**: Each picker MUST display a session-only status message (e.g., "set to X for this session only") after a Shift+S selection, distinct from the persistent-save message.
- **FR-005**: The Shift+S key-hint MUST appear in the picker's hint line whenever `onSessionOnlySelect` is provided, matching the `/model` picker UX.
- **FR-006**: The `/model` command's existing Shift+S behavior MUST remain unchanged.
- **FR-007**: The `onSessionOnlySelect` callback MUST pass the same `ModelSelection` shape (`{ alias, thinking }`) used by the `/model` command.
- **FR-008**: Each session-only handler MUST apply the model to the current session via the existing session-model mechanism (`setConfig` with the relevant section), mirroring how `/model` does it via `performModelSwitch(..., false)`.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every model-picker slash command listed in FR-001 supports Shift+S session-only selection.
- **SC-002**: Pressing Shift+S and selecting a model completes in under 2 seconds from key press to status display.
- **SC-003**: Global config remains unchanged after a session-only selection (verified by reading back the config section).
- **SC-004**: The `/model` command's existing behavior is not regressed (persistent save still works, Shift+S still works).
- **SC-005**: Tab autocompletion for all model-picker commands returns the same model list as before.
- **SC-006**: No config file is written when only a session-only selection is made.

---

## Assumptions

- The `TabbedModelSelectorComponent` already supports `onSessionOnlySelect` in its options (it is forwarded to each inner `ModelSelectorComponent`). The feature only requires wiring the callback through in each slash command's picker function.
- The session-model application mechanism already exists (`performModelSwitch` with `persistent: false`, or an equivalent `setConfig` call scoped to the current session).
- Each model section (`compactionModel`, `substituteModel`, `visualModel`, `secondaryModel`, `fallbackModel`) already has a setter that can be called with `setConfig` to override the session model.
- The `onSessionOnlySelect` callback shape is `({ alias, thinking }) => void`, matching the `ModelSelection` interface.
- The existing `performModelSwitch(host, alias, thinking, persistent)` pattern from `/model` is the reference implementation for session-only model application.
- The feature does not add new slash commands — it adds capability to existing ones.

---

## Notes

- This feature is a pure wiring/integration task: the UI infrastructure (`TabbedModelSelectorComponent`, `ModelSelectorComponent`, `onSessionOnlySelect`) already exists; the work is connecting each model-picker command to it.
- The `/model` command at `handleModelCommand` (around line 1050 of `config.ts`) is the reference implementation — all other pickers should follow the same `onSessionOnlySelect` pattern.
- Each session-only save should call `host.harness.setConfig` with the relevant config section (e.g., `{ compactionModel: { model: alias } }`) so the session override takes effect immediately.
- The status message for session-only selection should clearly distinguish itself from the persistent-save message (e.g., "…for this session only" vs "…will use it" for persistent).
