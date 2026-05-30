---
"@moonshot-ai/agent-core": minor
"@moonshot-ai/kimi-code": minor
---

Add API key pool for parallel subagent execution. When multiple `KIMI_API_KEY*` environment variables are configured, subagents rotate through them to avoid rate-limit contention, and failed keys are temporarily cooled down on retryable errors.
