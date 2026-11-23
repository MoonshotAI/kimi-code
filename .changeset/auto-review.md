---
"@moonshot-ai/kimi-code": minor
"kimi-code-app": patch
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kap-server": patch
"@moonshot-ai/kimi-code-sdk": patch
"@moonshot-ai/klient": patch
---

Add experimental Auto Review, which has a separate model review tool calls in Ask When Needed and Never Ask modes and shows review progress and denial reasons in approval prompts. Enable it with `[experimental] auto_review = true` or `KIMI_CODE_EXPERIMENTAL_AUTO_REVIEW=1`. The approval dialog also labels forced single-file removals as "force delete" instead of "recursive delete" and drops the separate sudo label.
