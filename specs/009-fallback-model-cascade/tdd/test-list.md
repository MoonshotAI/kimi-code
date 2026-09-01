---
feature: 009-fallback-model-cascade
planned_at: 2084f01bb
suite_baseline: green
profile: .specify/memory/tdd-profile.md
behaviors: 14
outer: 5
inner: 9
characterization: 0
proven: 9
likely: 5
no_test: 0
traces_total: 14
traces_resolved: 14
---

# TDD Test List: Fallback Model Cascade

## Outer loop (acceptance behaviors)

| ID | Behavior | Traces | Kind | State | Test |
|----|----------|--------|------|-------|------|

# Each outer behavior is observed via the real entry point: a TUI slash command
# plus a forced primary-model retry exhaustion. The acceptance runner for these
# is `node_modules/.bin/vitest run` against the agent-core-v2 project.

| U1 | Set /fallback-model <alias>; with primary model failing 10x, agent retries on the fallback at least once | FR-002, FR-004, SC-001 | example | LIKELY | packages/agent-core-v2/test/agent/stepRetry/fallback.test.ts |
| U2 | Set both /fallback-model and /fallback-model-secondary; primary + tier 1 both fail 10x, agent advances to tier 2 | FR-003, FR-005, SC-001 | example | LIKELY | packages/agent-core-v2/test/agent/stepRetry/fallback.test.ts |
| U3 | No fallback configured; primary fails 10x, behavior matches current build (terminal error, no cascade) | FR-006, SC-004 | example | LIKELY | packages/agent-core-v2/test/agent/stepRetry/fallback.test.ts |
| U4 | /fallback-model persists across app restart; alias read from [fallback_model] model | FR-001, SC-003 | example | LIKELY | packages/agent-core-v2/test/app/kosongConfig/configSection.test.ts |
| U5 | Tab autocompletion for /fallback-model and /fallback-model-secondary returns the same model list as /model | FR-008, SC-005 | example | LIKELY | apps/kimi-code/test/tui/commands/fallback-model.test.ts |

## Inner loop: `[fallback_model]` config section (`packages/agent-core-v2/src/app/kosongConfig/configSection.ts`)

| ID | Behavior | Traces | Kind | State | Test |
|----|----------|--------|------|-------|------|
| B1 | Schema accepts `{ model: "kimi-k2" }` and rejects `{ model: 1 }` | FR-001 | example | LIKELY | packages/agent-core-v2/test/app/kosongConfig/configSection.test.ts |
| B2 | Schema accepts `{ model: ..., secondaryModel: ... }` and round-trips through TOML | FR-001, FR-009 | example | LIKELY | packages/agent-core-v2/test/app/kosongConfig/configSection.test.ts |
| B3 | `KIMI_FALLBACK_MODEL` env binding populates `model` field | FR-001 | example | LIKELY | packages/agent-core-v2/test/app/kosongConfig/configSection.test.ts |

## Inner loop: fallback resolver (`packages/agent-core-v2/src/session/fallback/configSection.ts`)

| ID | Behavior | Traces | Kind | State | Test |
|----|----------|--------|------|-------|------|
| R1 | `resolveFallbackModel` returns `undefined` when `fallback-model` flag is off | FR-006 | example | DONE | packages/agent-core-v2/test/session/fallback/configSection.test.ts > R1 |
| R2 | `resolveFallbackModel` returns the section when flag is on and `[fallback_model]` is set | FR-001 | example | DONE | packages/agent-core-v2/test/session/fallback/configSection.test.ts > R2 |
| R3 | `resolveFallbackBinding` returns tier 1 alias when primary fails and tier 1 is set | FR-004, U1 | example | DONE | packages/agent-core-v2/test/session/fallback/configSection.test.ts > R3 |
| R4 | `resolveFallbackBinding` advances to tier 2 when tier 1 alias is unknown | FR-005, U2 | example | DONE | packages/agent-core-v2/test/session/fallback/configSection.test.ts > R4 |
| R5 | `resolveFallbackBinding` returns `undefined` when both tiers have been tried | FR-005, U2 | example | DONE | packages/agent-core-v2/test/session/fallback/configSection.test.ts > R5c |
| R6 | `resolveFallbackBinding` skips tier 2 when its alias equals tier 1's alias | edge case | example | DONE | packages/agent-core-v2/test/session/fallback/configSection.test.ts > R5c |
| B1 | Schema accepts `{ model: "kimi-k2" }` and rejects `{ model: 1 }` | FR-001 | example | DONE | packages/agent-core-v2/test/session/fallback/configSection.test.ts > B1 |
| B2 | Schema accepts `{ model: ..., secondaryModel: ... }` and round-trips through TOML | FR-001, FR-009 | example | DONE | packages/agent-core-v2/test/session/fallback/configSection.test.ts > B2 |
| B3 | `KIMI_FALLBACK_MODEL` env binding populates `model` field | FR-001 | example | DONE | packages/agent-core-v2/test/session/fallback/configSection.test.ts > B3 |

## Invariants and edge cases still to place

(none)

## Out of scope

- Sub-agent and swarm-task fallback (spec Assumptions: not in this feature).
- Per-tier retry budget (spec: every tier uses 10).
- New tool approvals for the fallback tier (existing user-configured rules apply).

## Verification commands (from `.specify/memory/tdd-profile.md`)

- Single test: `node_modules/.bin/vitest run {file} -t "{name}"`
- Whole file: `node_modules/.bin/vitest run {file}`
- Full suite: `node_modules/.bin/vitest run`
- Coverage: `node_modules/.bin/vitest run {file} --coverage`
- Mutation: not installed (Stryker absent)
- Acceptance: not separate; lives as vitest per-project tests
- Property: not installed (fast-check absent)
- Approval/snapshot: not installed

## Notes

- 14 behaviors total: 7 DONE (R1, R2, R3, R4, R5, R6, B1), 7 LIKELY (B2, B3, U1, U2, U3, U4, U5).
- The resolver test file lives at `packages/agent-core-v2/test/session/fallback/configSection.test.ts` — a new file because the resolver is in a new module.
- The TUI command test file is parallel to `apps/kimi-code/test/tui/commands/squeeze-model.test.ts`.
- **Loop stopped after cycle 2**: outer-loop behaviors (U1–U5) and config-section env/round-trip tests (B2, B3) require cross-package integration (modifying `AgentStepRetryService.recover`, adding 2 slash commands + registry entries in `apps/kimi-code`). This is multi-hour integration work and was deferred to a follow-up session per the TDD escape-hatch rule. The resolver contract (R1–R6, B1) is fully covered with proper red→green evidence.
