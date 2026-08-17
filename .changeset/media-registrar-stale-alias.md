---
"@moonshot-ai/kimi-code": patch
---

Fix an `[unexpected] Error2: Model "<alias>" is not configured in config.toml` error printed on startup when a restored session references a model that is no longer configured (e.g. after logging out of the managed Kimi Code account). Media tool registration now degrades gracefully instead of throwing from the `agent.status.updated` listener.
