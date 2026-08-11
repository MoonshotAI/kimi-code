---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": patch
---

Fail stalled provider streams instead of hanging the turn forever. `generate()` now watches for stream inactivity (default budget 300s per gap, `KIMI_STREAM_STALL_TIMEOUT_MS` to override, `0` to disable): when no part arrives within the budget the connection is torn down and an `APITimeoutError` is thrown, which the existing retry classification already treats as retryable — transient stalls recover via `chatWithRetry`, persistent ones end the turn with a real error. Cancelling a stalled stream now also aborts promptly instead of hanging until the next part.
