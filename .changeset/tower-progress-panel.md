---
"@moonshot-ai/kimi-code-sdk": minor
"@moonshot-ai/kimi-code": minor
---

Add Session.getTowerProjection() and Session.watchTowerProjection() to read a workspace's tower mission-control state — open missions with task progress, reconciled roster liveness, and recent activity events — as a one-shot snapshot or a watched stream.

Add a tower progress side panel in fullscreen mode: with tower mode on, a right-hand column shows open missions with task progress, live worker counts, recent tower activity, and recently closed missions (hidden on terminals narrower than 120 columns). Requires the tower experiment (KIMI_CODE_EXPERIMENTAL_TOWER=1) and tui_mode = "fullscreen".
