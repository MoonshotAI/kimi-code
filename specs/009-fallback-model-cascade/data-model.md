# Data Model: Fallback Model Cascade

**Feature**: 009-fallback-model-cascade
**Date**: 2026-09-01

## Config Section: `[fallback_model]`

The user-facing configuration that drives the cascade.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string (alias) | no | First-tier fallback alias. Tried after the primary model exhausts its retry budget. |
| `secondary_model` | string (alias) | no | Second-tier fallback alias. Tried after the first-tier fallback exhausts its retry budget. |

Both fields are optional. If both are unset, the cascade is a no-op and the existing error behavior applies.

**TOML shape**:
```toml
[fallback_model]
model = "kimi-k2"
secondary_model = "gpt-4o-mini"
```

**Env vars** (mirroring the `compactionModel` env bindings pattern):
- `KIMI_FALLBACK_MODEL` → `model`
- `KIMI_FALLBACK_SECONDARY_MODEL` → `secondary_model`

## State: `stepRetry.failedAttempts` and `stepRetry.lastFailedDriverId`

These are existing per-agent state keys; the cascade does not introduce new persistent state. After every step finishes successfully, both are reset.

## Behavior Cascade

```
primary model → (10 attempts exhausted) → fallback_model.model
                                            → (10 attempts exhausted) → fallback_model.secondary_model
                                                                                    → terminal error
```

Each tier uses the existing `DEFAULT_MAX_RETRY_ATTEMPTS = 10` budget. Each tier is an independent retry round; backoff, jitter, and event emission all reuse the existing `AgentStepRetryService.recover` logic.

## Validation Rules

- Each alias must exist in `[models]` at resolution time, or the cascade skips that tier.
- If `model` and `secondary_model` are the same alias, the second tier is skipped (no-op).
- If either alias is empty/unset, that tier is skipped (cascade collapses to fewer tiers).
