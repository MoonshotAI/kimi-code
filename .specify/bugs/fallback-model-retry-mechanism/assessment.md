# Bug Assessment: No fallback model mechanism on request failures

- **Slug**: fallback-model-retry-mechanism
- **Created**: 2025-08-26T08:00:02.053Z
- **Source**: pasted text
- **Verdict**: valid
- **Severity**: high

## Report (verbatim or summarized)

> when a request fails there is no fallback mechanism. create a fallback model with option retryAfterErrorCount default to 3 max 10 min 1 so if set after 3 tries it tries with the fallback model and if successed it switches to that fallback model. this should apply to all models in all scenarios so no need to go extra detail of indivual fallback model setting, so lets say a swarm agent failed it retries with fallback and sucessed and change its model. so every session, agent only changes to fallback on only in its own scope.

## Symptom

When an LLM request fails (rate limit, timeout, provider error), there's no automatic fallback to an alternative model. Users must manually change models via `/model` command. The request is retried with the same model (up to 10 attempts by default in `chatWithRetry`), but if the model is fundamentally unavailable (quota exhausted, model deprecated, provider down), retries will never succeed.

## Reproduction

1. Configure a session with a primary model
2. Exhaust the quota for that model (or simulate a provider outage)
3. Send a prompt — requests fail with rate limit / quota errors
4. Observe that retries continue with the same failing model (up to 10 attempts)
5. No automatic switch to a fallback model occurs

## Suspected Code Paths

- `packages/agent-core/src/loop/retry.ts` — `chatWithRetry()` (lines 38-89): Implements retry logic with exponential backoff but **no model fallback**. Only retries the same LLM instance.
- `packages/agent-core/src/loop/llm.ts` — `LLM` interface and implementations: Each LLM is bound to a specific model; no fallback chain.
- `packages/agent-core/src/session/provider-manager.ts` — `ProviderManager`: Resolves provider config for a model alias; could be extended to resolve fallback chain.
- `packages/agent-core-v2/src/agent/loop/loop.ts` — Agent loop that calls `chatWithRetry`
- `packages/kosong/src/provider.ts` — Provider abstraction; errors include `APIProviderRateLimitError`

## Root Cause Hypothesis

**Confidence: high**

The retry mechanism in `chatWithRetry` (agent-core v1) only retries the **same LLM instance** with the same model. There's no concept of a "fallback model" in the LLM abstraction or the retry logic. The `maxAttempts` (default 10) only controls how many times to retry the same model, not when to switch models.

In agent-core-v2, the loop likely uses a similar pattern. The `ProviderManager` can resolve different model aliases, but there's no configuration for fallback chains or automatic switching on failure.

## Proposed Remediation

**Preferred**: Add a global fallback model configuration with retry threshold

1. **Add config section** (e.g., `[fallback_model]` in `config.toml`):
   - `model`: fallback model alias
   - `retryAfterErrorCount`: number of failed attempts before fallback (default: 3, min: 1, max: 10)
   - `enabled`: boolean (default: false)
2. **Modify `chatWithRetry`** (and v2 equivalent) to:
   - Track consecutive failures per agent/session scope
   - After `retryAfterErrorCount` failures, attempt request with fallback model
   - If fallback succeeds, **switch the agent's model to the fallback** for subsequent requests (persist in agent config)
   - Scope the switch to the individual agent (session, subagent, swarm agent each track their own fallback state)
3. **Add fallback model resolution** in `ProviderManager` / kosong provider layer

**Alternatives**:
- Per-model fallback configuration (more granular but complex)
- Fallback only on specific error codes (rate limit, quota, unavailable) — not all errors
- Event-based: emit `model.fallback` event for UI notification

**Files likely to change**:
- `packages/agent-core/src/loop/retry.ts` — core retry logic modification
- `packages/agent-core/src/config/schema.ts` — add `FallbackModelConfigSchema`
- `packages/agent-core/src/config/` — new `fallback-model.ts` for overlay/logic
- `packages/agent-core/src/session/provider-manager.ts` — fallback model resolution
- `packages/agent-core-v2/src/agent/loop/loop.ts` — v2 loop integration
- `packages/agent-core-v2/src/app/kosongConfig/` — v2 config section

**Tests to add or update**:
- Test that after N failures, fallback model is attempted
- Test that successful fallback switches the agent's model persistently
- Test that fallback is scoped per-agent (swarm agent fallback doesn't affect parent)
- Test that `retryAfterErrorCount` bounds (1-10) are enforced
- Test that fallback only triggers on retryable errors (rate limit, not validation errors)

## Risks & Considerations

- **Scope isolation**: Each agent (session, subagent, swarm agent) must have independent fallback state. A swarm agent falling back should not change the parent's model.
- **Error classification**: Only retryable errors (rate limit, timeout, 5xx) should trigger fallback. Invalid requests (400) should not.
- **Infinite fallback loop**: If fallback also fails, should not keep switching models. Max one fallback switch per agent per session.
- **Config persistence**: When an agent switches to fallback, should the config be persisted? User said "switches to that fallback model" — implies persistent change for that agent.
- **Provider compatibility**: Fallback model must be from a compatible provider (or at least callable via kosong).

## Open Questions

- [NEEDS CLARIFICATION: Should fallback apply to all error types or only rate limit / quota errors?]
- [NEEDS CLARIFICATION: Should the fallback model switch be persisted to config.toml or only in-memory for the session?]
- [NEEDS CLARIFICATION: Should there be a fallback chain (fallback of fallback) or just one level?]
- [NEEDS CLARIFICATION: Does this need to work in both agent-core (v1) and agent-core-v2, or only v2?]
- [NEEDS CLARIFICATION: How should the fallback model be specified — a single global fallback, or per-model fallback mapping?]