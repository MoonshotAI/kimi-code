---
"@moonshot-ai/kimi-code": minor
---

Show the 5-hour and weekly plan quota persistently: the TUI footer now renders a compact `5h: X% 1w: Y%` readout next to the context meter (fetched on session start and refreshed by `/usage` and `/status`), and the web sidebar gets a "Plan usage" card above the session list with per-window progress bars and a manual refresh, backed by a new `GET /api/v1/usages` route.
