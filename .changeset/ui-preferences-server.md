---
"@moonshot-ai/kap-server": minor
"@moonshot-ai/kimi-code-product": minor
---

Add server-side UI preferences: `GET` and `PATCH /api/v1/ui-preferences`, `POST /api/v1/ui-preferences:import`, and a `ui_preferences` global WebSocket event. Preferences are stored in `ui-preferences.json` in the data directory and merged per key; a corrupted file is kept as `ui-preferences.json.bak` and the preferences start over.
