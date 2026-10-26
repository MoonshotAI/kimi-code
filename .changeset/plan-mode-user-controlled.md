---
"@moonshot-ai/kimi-code": minor
---

Plan mode now starts only when you turn it on, and every plan waits for your review: the agent can no longer enter Plan mode by itself, Never Ask no longer approves plans automatically, and `kimi -p` skips `default_plan_mode` and cannot approve the plan of a session that is already in Plan mode.
