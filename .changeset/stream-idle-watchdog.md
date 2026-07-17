---
"@moonshot-ai/kimi-code": patch
---

Fail loudly and automatically retry when a provider stream stalls mid-flight. The underlying OpenAI-compatible client clears its request timeout as soon as response headers arrive, so a silent SSE stall used to hang `generate()` — and the whole turn — forever. The new inter-chunk idle watchdog (default 180 s, tunable via `KIMI_STREAM_IDLE_TIMEOUT_MS`) is applied to both stream loops in the CLI bundle — `packages/kosong/src/generate.ts` (used by the ACP path: kimi-code → kimi-code-sdk → agent-core → kosong) and `packages/agent-core-v2/src/app/llmProtocol/generate.ts` (used by the kap-server path) — cancelling the stream and raising an `APITimeoutError` subclass (`StreamIdleTimeoutError`) that carries elapsed time and the Kimi `x-trace-id`. The loop's step-retry plugin classifies it as retryable and re-drives the failed step, so the user sees a `step.retrying` recovery instead of a permanent hang.
