---
"@moonshot-ai/kimi-code": patch
---

Replace the per-session timestamp in the default system prompt with a static time-lookup reminder. The timestamp changed on every new session, breaking DeepSeek's byte-prefix cache from that point onward — including the ~16.8k-token tools definition — so every new session's first LLM call missed the cache. First-turn cache-miss input drops from ~19.5k tokens to ~88 tokens (99.6% cache hit measured on the built artifact). The static `## Date and Time` section keeps the instruction to fetch the real current time from the environment (e.g. via the `date` command) when it matters, without the cache-breaking value.
