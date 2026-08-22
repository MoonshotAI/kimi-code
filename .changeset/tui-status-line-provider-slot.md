---
"@moonshot-ai/kimi-code": patch
---

Add a `provider` slot to the TUI footer status line, so the status bar can show which provider serves the current model. List it in `[status_line].items` to enable it, and it is also available as `provider` in the `[status_line].command` JSON payload.
