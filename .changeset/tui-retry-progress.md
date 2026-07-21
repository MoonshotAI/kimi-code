---
"@moonshot-ai/kimi-code": patch
---

Show live retry progress in the TUI activity pane. When an LLM request fails and is retried, the moon spinner now shows a warning-colored status like `Rate limited (429) · attempt 3/10 · retrying in 12s` with a live countdown, instead of an unchanged generic spinner for the whole backoff window. The failed attempt's partial output is discarded before the next attempt re-streams.
