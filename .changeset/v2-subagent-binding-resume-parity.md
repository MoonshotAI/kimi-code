---
"@moonshot-ai/kimi-code": patch
---

Fix the experimental subagent model bindings: a resumed subagent now fails fast with a clear error when its bound model alias no longer resolves, and binding warnings cover aliases that exist but cannot be resolved, including a notice when `inherit = true` is set alongside an ignored model or thinking effort.
