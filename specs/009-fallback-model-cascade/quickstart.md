# Quickstart: Fallback Model Cascade

**Feature**: 009-fallback-model-cascade
**Date**: 2026-09-01

## Prerequisites

- A `config.toml` with a working primary model.
- At least one other model alias configured in `[models]`.
- The `fallback-model` experiment flag is **off** by default; users opt in via `/fallback-model`.

## Validation scenario 1: Cascade with both tiers configured

1. Open the TUI.
2. Run `/fallback-model kimi-k2` — verify a success status appears.
3. Run `/fallback-model-secondary gpt-4o-mini` — verify a success status.
4. Trigger a conversation that exhausts the primary model's retry budget (e.g., set `KIMI_LOOP_MAX_ATTEMPTS_PER_STEP=1` to force fast exhaustion).
5. **Expected**: the agent retries on `kimi-k2`, then on `gpt-4o-mini`, and only then surfaces a terminal error.

## Validation scenario 2: Cascade with only the first tier

1. Run `/fallback-model kimi-k2`.
2. Do NOT set a secondary.
3. Trigger primary-model failure.
4. **Expected**: the agent retries on `kimi-k2` exactly once and surfaces a terminal error on its own.

## Validation scenario 3: No cascade configured

1. Do not run either slash command.
2. Trigger primary-model failure.
3. **Expected**: behavior is identical to the current build — terminal error after the primary budget is exhausted.

## Validation scenario 4: Alias not in `[models]`

1. Run `/fallback-model ghost-model`.
2. Trigger primary-model failure.
3. **Expected**: the cascade skips `ghost-model` and proceeds to the next tier (or terminal error if no second tier). No crash.

## Validation scenario 5: Slash command persistence

1. Run `/fallback-model kimi-k2`.
2. Restart the application.
3. Read the config: `cat config.toml | grep -A 3 fallback_model`.
4. **Expected**: `[fallback_model] model = "kimi-k2"` is present.

## Validation scenario 6: Experiment flag is off

1. Do not run either slash command.
2. Read the config: `[experimental]`.
3. **Expected**: `fallback-model` is not set, and the cascade resolver short-circuits to `undefined`.
