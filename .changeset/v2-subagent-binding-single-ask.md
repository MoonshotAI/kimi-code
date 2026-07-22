---
"@moonshot-ai/kimi-code": patch
---

Fix the experimental subagent model bindings: one spawn now asks at most once — when a binding slot was explicitly requested and its ask was dismissed, the resolver no longer escalates into a second, type-level question; a configured type binding still applies silently.
