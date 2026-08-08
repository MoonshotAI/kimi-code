---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code-sdk": patch
"@moonshot-ai/kimi-code": patch
---

Fix "Approve for this session" being ignored for Bash commands containing quotes, parentheses, or pipes. The stored approval rule escapes glob metacharacters but was re-matched through picomatch, which dropped the quotes and never matched the original command, so the identical command was prompted again. An exact-literal match now short-circuits before glob matching.
