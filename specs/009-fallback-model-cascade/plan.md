# Implementation Plan: Fallback Model Cascade

**Branch**: `009-fallback-model-cascade` (on `827-fallback-model-cascade`)
**Date**: 2026-09-01
**Spec**: [spec.md](./spec.md)

## Summary

Add a `[fallback_model]` config section plus `/fallback-model` and `/fallback-model-secondary` slash commands. After the primary model exhausts its 10-attempt retry budget, the agent loop transparently retries on the first-tier fallback, then on the second-tier fallback, and only then surfaces a terminal error. Mirrors the existing `[compaction_model]` cascade but applies to the main agent loop.

## Technical Context

**Language/Version**: TypeScript 5.x (Node.js >= 24.15.0)
**Primary Dependencies**: `@moonshot-ai/agent-core-v2`, `@moonshot-ai/kosong`, `zod`
**Storage**: TOML config (`config.toml`); no new persistence layer
**Testing**: vitest (`packages/agent-core-v2/test`)
**Target Platform**: TUI (`apps/kimi-code`) + agent-core-v2 server
**Project Type**: monorepo library + CLI
**Performance Goals**: no new perf budget; the cascade adds one extra retry round per tier (existing backoff applies)
**Constraints**: comment-free zone in `agent-core-v2`; preserve existing test suite
**Scale/Scope**: adds one config section, one experiment flag, two slash commands, one resolver helper

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The `.specify/memory/constitution.md` is currently the template skeleton (no filled-in principles), so no gates apply. Re-check after design: no comments in agent-core-v2 (rule enforced by `scripts/check-no-comments.mjs`), no breakage of existing retry / substitute / compaction behavior.

## Project Structure

### Documentation (this feature)

```text
specs/009-fallback-model-cascade/
├── plan.md                # this file
├── spec.md                # feature specification
├── research.md            # Phase 0 output
├── data-model.md          # Phase 1 output
├── quickstart.md          # Phase 1 output
├── contracts/             # Phase 1 output
│   └── config-contract.md
├── tasks.md               # Phase 2 output (next: /skill:speckit-tasks)
└── tdd/                   # TDD artifacts (next: /skill:speckit-tdd-plan)
```

### Source Code

```text
packages/agent-core-v2/src/
├── app/kosongConfig/configSection.ts   # add FALLBACK_MODEL_SECTION + schema
├── agent/stepRetry/stepRetryService.ts # add tryFallback hook
├── agent/loop/configSection.ts         # no change (reuse existing budget)
├── session/compaction/configSection.ts # reference (read-only)
└── app/flag/flag.ts                    # register 'fallback-model' flag (if not present)

apps/kimi-code/src/tui/commands/
└── config.ts                           # add /fallback-model + /fallback-model-secondary
```

**Structure Decision**: mirror the compaction-model layout exactly — same `registerConfigSection` pattern, same `resolve*` helper shape, same `handle*` slash command shape. This minimizes cognitive load and reuses all established patterns.

## Complexity Tracking

No constitution violations. The feature reuses existing primitives (`ModelOverrideSchema`, `TabbedModelSelectorComponent`, `AgentStepRetryService.recover`, `DEFAULT_MAX_RETRY_ATTEMPTS`) without introducing new abstractions.

## Design Decisions

1. **One config section `[fallback_model]`** with `model` + `secondary_model` fields. Mirrors `[compaction_model]`.
2. **`fallback-model` experiment flag** gates the feature off by default. Same shape as `compaction-model`.
3. **Wired into `AgentStepRetryService.recover`**: after `failedAttempts >= maxAttempts` returns `false`, call `tryFallback` before the caller surfaces a terminal error. The fallback path itself uses the same `recover` loop, so the second tier's retries go through the same backoff and event emission.
4. **Each tier gets its own 10-attempt budget**. The `failedAttempts` counter resets when the driver id changes (already implemented).
5. **Alias validation** at resolution time: if the alias is not in `[models]`, the tier is skipped (cascade collapses).

## Open Questions

None. The spec is complete; all FR/SC map to existing patterns.
