---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kap-server": patch
"@moonshot-ai/kimi-code-sdk": patch
---

Keep the `model` parameter static in subagent tool schemas, deliver available subagent models via `<system-reminder>` messages instead of tool descriptions, and reject invalid or resume-time `model` arguments with explicit errors.
