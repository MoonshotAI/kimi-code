---
"@moonshot-ai/kimi-code": patch
---

Honor the turn's abort signal in the WebSearch and FetchURL tools. Cancelling a turn (Ctrl-C) now aborts the in-flight HTTP request instead of leaving it running in the background: the signal is threaded through the tools to the Moonshot fetch/search providers and the local fallback fetcher's per-hop request. A caller-driven abort of the Moonshot fetch no longer retries the local fallback, so cancellation surfaces cleanly.
