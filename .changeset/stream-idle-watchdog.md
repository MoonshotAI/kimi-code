---
"@moonshot-ai/kimi-code": patch
---

Fail loudly and automatically retry when a provider stream stalls mid-flight. The underlying OpenAI-compatible client clears its request timeout as soon as response headers arrive, so a silent SSE stall used to hang `generate()` — and the whole turn — forever. The new idle watchdog (default 180 s, tunable via `KIMI_STREAM_IDLE_TIMEOUT_MS`) cancels the stream and raises an `APITimeoutError` subclass carrying elapsed time and the Kimi `x-trace-id`, which the loop's step-retry plugin picks up to re-drive the failed step.
