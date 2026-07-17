---
"@moonshot-ai/kimi-code": minor
---

Refresh the model list automatically for Kimi providers that authenticate with an API key against the Kimi Code managed endpoint, matching the OAuth login behavior. Point the provider's `base_url` at the managed endpoint and set `api_key` (or `KIMI_API_KEY` in its `env` table); the list refreshes on startup and on the daemon's periodic schedule.
