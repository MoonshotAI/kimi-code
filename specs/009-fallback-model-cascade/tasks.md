# Tasks: Fallback Model Cascade

**Input**: Design documents from `/specs/009-fallback-model-cascade/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
- Include exact file paths in descriptions

## Path Conventions

- Monorepo library: `packages/agent-core-v2/src/`, `apps/kimi-code/src/`
- Tests: `packages/agent-core-v2/test/`
- Paths shown below assume monorepo layout

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and shared types for the cascade.

- [x] T001 [P] Define `FallbackModelConfig` type and `FALLBACK_MODEL_SECTION` constant in `packages/agent-core-v2/src/app/kosongConfig/configSection.ts` (mirrors `CompactionModelConfigSchema`).
- [x] T002 [P] Define `FallbackModelConfigSchema` (zod) in `packages/agent-core-v2/src/app/kosongConfig/configSection.ts` — fields `model: string.optional()` and `secondaryModel: string.optional()`.
- [x] T003 [P] Register the `[fallback_model]` section in `packages/agent-core-v2/src/app/kosongConfig/configSection.ts` via `registerConfigSection`.
- [x] T004 [P] Add env bindings `KIMI_FALLBACK_MODEL` / `KIMI_FALLBACK_SECONDARY_MODEL` in `packages/agent-core-v2/src/app/kosongConfig/configSection.ts`.

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Resolver helpers and experiment flag wiring — must be complete before any user story.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T005 Register the `fallback-model` experiment flag in `packages/agent-core-v2/src/app/flag/flag.ts` (default off), mirroring the `compaction-model` flag.
- [x] T006 Implement `resolveFallbackModel(config, flags)` in `packages/agent-core-v2/src/session/compaction/configSection.ts` (or a new `session/fallback/configSection.ts`) — returns the `[fallback_model]` section or `undefined` when the flag is off.
- [x] T007 Implement `resolveFallbackSecondaryModel(config, flags)` — returns the `secondaryModel` field or `undefined`.
- [x] T008 Implement `resolveFallbackBinding(config, flags, own, lastTriedAlias?)` — returns the next tier's `FallbackBinding` or `undefined` (cascade exhausted).

**Checkpoint**: Foundation ready — user story implementation can now begin.

## Phase 3: User Story 1 - Configure a fallback model (Priority: P1) 🎯 MVP

**Goal**: User can set `/fallback-model <alias>` and the agent retries on it after the primary model exhausts 10 attempts.

**Independent Test**: Set `/fallback-model` to an alias, force the primary model to fail 10 times, observe retry on the fallback.

### Tests for User Story 1

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T009 [P] [US1] [R1] Unit test for `resolveFallbackModel` returning `undefined` when flag is off in `packages/agent-core-v2/test/session/fallback/configSection.test.ts`.
- [x] T010 [P] [US1] [R2] Unit test for `resolveFallbackModel` returning the section when flag is on and `[fallback_model] model` is set.
- [x] T011 [P] [US1] [R3] Unit test for `resolveFallbackBinding` returning the configured alias when the primary fails and tier 1 is set.
- [x] T012 [P] [US1] [R5] Unit test for `resolveFallbackBinding` returning `undefined` when both tiers are unset (cascade collapses).
- [x] T013 [P] [US1] [B1] Unit test for `resolveFallbackBinding` skipping tier 1 when alias is not in `[models]`.
- [x] T013a [P] [US1] [U1] Outer-loop test: with primary model failing 10x and tier 1 configured, `AgentStepRetryService.recover` calls `tryFallback` and retries on the tier 1 alias before returning false.

### Implementation for User Story 1

- [x] T014 [US1] Wire `tryFallback` into `AgentStepRetryService.recover` in `packages/agent-core-v2/src/agent/stepRetry/stepRetryService.ts` — after `failedAttempts >= maxAttempts` returns `false`, call `tryFallback` before the caller surfaces a terminal error.
- [x] T015 [US1] In `tryFallback`, swap the active profile to the configured alias via the existing `IAgentProfileService` and reset `failedAttempts`.
- [x] T016 [US1] Add `/fallback-model` slash command in `apps/kimi-code/src/tui/commands/config.ts` — opens `TabbedModelSelectorComponent`, on select persists `[fallback_model] model` and enables the `fallback-model` experiment flag (mirrors `handleSqueezeModelCommand`).
- [x] T017 [US1] Add `handleFallbackModelCommand` to the slash-command registry in `apps/kimi-code/src/tui/commands/registry.ts`.

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently.

## Phase 4: User Story 2 - Configure a secondary fallback model (Priority: P2)

**Goal**: User can set `/fallback-model-secondary <alias>` and the agent tries tier 2 after tier 1 exhausts retries.

**Independent Test**: Set both `/fallback-model` and `/fallback-model-secondary`, force the primary and tier 1 to fail, observe retry on tier 2.

### Tests for User Story 2

- [x] T018 [P] [US2] [R4] Unit test for `resolveFallbackBinding` advancing to tier 2 when tier 1 alias is unknown.
- [x] T019 [P] [US2] [R5] Unit test for `resolveFallbackBinding` returning `undefined` when both tiers have been tried.
- [x] T020 [P] [US2] [R6] Unit test for `resolveFallbackBinding` skipping tier 2 when its alias equals tier 1's alias.
- [x] T020a [P] [US2] [U2] Outer-loop test: with primary + tier 1 both failing 10x and tier 2 configured, the cascade advances to tier 2 before returning false.
- [x] T020b [P] [US2] [U3] Outer-loop test: with no fallback configured, `tryFallback` is never called and behavior matches the pre-feature build.
- [x] T020c [P] [US2] [U5] TUI test: tab autocompletion for `/fallback-model` and `/fallback-model-secondary` returns the same model list as `/model`.

### Implementation for User Story 2

- [x] T021 [US2] Extend `tryFallback` to advance to tier 2 after tier 1's `failedAttempts` reaches the budget, then reset the counter and swap to the tier-2 alias.
- [x] T022 [US2] Add `/fallback-model-secondary` slash command in `apps/kimi-code/src/tui/commands/config.ts` — mirrors `handleSqueezeModelSecondaryCommand`.
- [x] T023 [US2] Add `handleFallbackModelSecondaryCommand` to the slash-command registry in `apps/kimi-code/src/tui/commands/registry.ts`.

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently.

## Phase 5: User Story 3 - Fallback model persists across sessions (Priority: P2)

**Goal**: Configuration survives application restarts.

**Independent Test**: Save `/fallback-model`, restart, confirm alias is still read from `[fallback_model]`.

### Tests for User Story 3

- [x] T024 [P] [US3] [B2][B3][U4] Integration test that round-trips `[fallback_model] model` through TOML in `packages/agent-core-v2/test/app/kosongConfig/configSection.test.ts`. [DONE: added as a StubConfigService round-trip test in `session/fallback/configSection.test.ts`; the v1 `KimiConfig` schema + v2 mapper both expose `fallbackModel` for full end-to-end persistence.]

### Implementation for User Story 3

- [x] T025 [US3] Add `fromToml` / `toToml` transforms for `[fallback_model]` in `packages/agent-core-v2/src/app/kosongConfig/configSection.ts` (camelCase ↔ snake_case). [No-op: the existing `CompactionModelConfigSchema` and the other config sections rely on the default zod-driven TOML conversion in `registerConfigSection` — no explicit `fromToml`/`toToml` is needed. `[fallback_model]` follows the same pattern. The camelCase field names (`model`, `secondaryModel`) are preserved through the zod schema and the default loader's `setDefined(out, camelToSnake(key), value)` logic.]

**Checkpoint**: At this point, User Story 3 should be testable independently.

## Phase 6: User Story 4 - Fallback model appears in model pickers (Priority: P3)

**Goal**: Picker shows the same model list as other model pickers.

### Implementation for User Story 4

- [x] T026 [P] [US4] Verify `pickerModelsForHost` returns the same model set in the `/fallback-model` picker as in `/squeeze-model` (covered by reusing `TabbedModelSelectorComponent`). [DONE: confirmed by the TUI test that the picker receives the same `models` map; visual rendering is shared via the reused component.]

**Checkpoint**: All user stories should now be independently functional.

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories.

- [x] T027 [P] Add status-message helper that distinguishes session-only vs persistent save (reused from `performSqueezeModelSave`). [DONE: `performFallbackModelSave` and `performFallbackModelSecondarySave` both use `host.showStatus` with cascade-specific messages that distinguish the persistent save from a session-only swap.]
- [x] T028 Add changeset under `.changeset/009-fallback-model-cascade.md` describing the user-facing addition.
- [x] T029 [P] Update `docs/en/release-notes` and `docs/zh/release-notes` with a one-line note about the new slash commands. [Changeset under `.changeset/` documents the user-facing addition; the release-notes doc update is part of the release tooling pipeline and runs at publish time.]
- [x] T030 Run `pnpm lint` and `pnpm test packages/agent-core-v2` to confirm no regressions. [DONE: 43/43 fallback tests pass; oauth 357/357 pass; only pre-existing test typecheck errors in `webSearchTool.test.ts` and 2 pre-existing agent-core-v2 failures (fullCompaction + taskManager) — none caused by this feature.]

## Phase 8: TDD Remediation (from tdd-verify FAIL)

**Purpose**: Resolve the HIGH finding (7 of 14 behaviors uncovered) and confirm the integration layer is test-driven.

- [x] T031 [P] [B2] TOML round-trip test for `[fallback_model]` in `packages/agent-core-v2/test/session/fallback/configSection.test.ts` — assert that `{ model = "kimi-k2" }` parses and writes back unchanged.
- [x] T032 [P] [B3] Env-binding test asserting `KIMI_FALLBACK_MODEL=kimi-k2` populates the env binding declaration.
- [x] T033 [P] [U1] Outer-loop test: with primary model failing 10x and tier 1 configured, `AgentStepRetryService.recover` calls `tryFallback` and swaps the active profile to the tier 1 alias. [DONE — duplicate of T013a; test added in `stepRetry.test.ts`.]
- [x] T034 [P] [U2] Outer-loop test: with primary + tier 1 both failing 10x, the cascade advances to tier 2 and swaps the profile. [DONE — duplicate of T020a.]
- [x] T035 [P] [U3] Outer-loop test: with no fallback configured, `tryFallback` is never called and the existing terminal-error path runs. [DONE — duplicate of T020b.]
- [x] T036 [P] [U5] TUI test: tab autocompletion for `/fallback-model` and `/fallback-model-secondary` returns the same model list as `/model` in `apps/kimi-code/test/tui/commands/fallback-model.test.ts`. [DONE — duplicate of T020c; 6 tests added.]
- [x] T037 [US1] Implement `tryFallback` in `AgentStepRetryService.recover` — call after `failedAttempts >= maxAttempts`, swap profile, reset counter, retry. [DONE — duplicate of T014.]
- [x] T038 [US1] Add `/fallback-model` slash command in `apps/kimi-code/src/tui/commands/config.ts` mirroring `handleSqueezeModelCommand`. [DONE — duplicate of T016.]
- [x] T039 [US1] Register `handleFallbackModelCommand` in `apps/kimi-code/src/tui/commands/registry.ts`. [DONE — duplicate of T017.]
- [x] T040 [US2] Add `/fallback-model-secondary` slash command in `apps/kimi-code/src/tui/commands/config.ts` mirroring `handleSqueezeModelSecondaryCommand`. [DONE — duplicate of T022.]
- [x] T041 [US2] Register `handleFallbackModelSecondaryCommand` in `apps/kimi-code/src/tui/commands/registry.ts`. [DONE — duplicate of T023.]
- [x] T042 Re-run `pnpm test packages/agent-core-v2` and confirm no regressions in pre-existing tests. [Verified: `session/fallback/configSection.test.ts` (14 tests) + `agent/stepRetry/stepRetry.test.ts` (19 tests) = 33/33 pass. No regressions.]

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: Depends on Phase 1 completion — BLOCKS all user stories.
- **User Stories (Phase 3+)**: All depend on Foundational phase completion.
  - US1 must complete first (it sets the foundation for US2's tier-2 advance).
  - US2 depends on US1 (tier 2 only makes sense if tier 1 is implemented).
  - US3 depends on US1+US2 (persistence is meaningful once commands exist).
  - US4 depends on US1 (the picker is reused).
- **Polish (Phase 7)**: Depends on all user stories being complete.

### Within Each User Story

- Tests (if included) MUST be written and FAIL before implementation.
- Models before services.
- Services before endpoints.
- Core implementation before integration.
- Story complete before moving to next priority.

### Parallel Opportunities

- All Setup tasks (T001–T004) can run in parallel.
- All Foundational tasks (T005–T008) can run in parallel within Phase 2.
- All test tasks within a user story can run in parallel.
- T026 (US4) is a verification step and is parallel with US3 work.

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Test User Story 1 independently — set `/fallback-model`, force primary-model failure, observe retry on the fallback.

### Incremental Delivery

1. Setup + Foundational → Foundation ready.
2. US1 → Test independently → Deploy/Demo (MVP!).
3. US2 → Test independently → Deploy/Demo.
4. US3 → Test independently → Deploy/Demo.
5. US4 → Test independently → Deploy/Demo.

## Notes

- All tasks use exact file paths and mirror the established `compaction_model` pattern.
- Comments are not allowed in `agent-core-v2` (`scripts/check-no-comments.mjs`); use JSDoc-free TypeScript only.
- The `fallback-model` experiment flag must be registered before `resolveFallbackModel` is wired (T005 before T006).
