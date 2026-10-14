---
"@moonshot-ai/kimi-code": patch
---

Reject an unknown `subagent_type` in the Agent tool immediately instead of failing later at spawn; an empty `subagent_type` is now rejected too rather than treated as unset.
