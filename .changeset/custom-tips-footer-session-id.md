---
"@moonshot-ai/kimi-code": patch
---

Extend the status-line framework: add a `sessionId` footer slot (opt-in via `[status_line].items`) and `[tips]` custom spinner tips with append/replace modes. Custom tips apply at startup and on `/reload-tui`; `/config` saves round-trip `[tips]` and `[status_line]` instead of dropping them.
