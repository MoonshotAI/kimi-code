---
"@moonshot-ai/kimi-code": minor
---

Add a scriptable statusline to the TUI footer. Set `[statusline] command` in `tui.toml` to a shell command and the CLI runs it periodically (`interval_ms`, `timeout_ms` are configurable), passing the session context as JSON on stdin — session id, model, working directory, permission mode, plan mode, and context token usage. The first stdout line (ANSI SGR colors included) is rendered as a third footer line. An empty command disables the feature; failed runs silently keep the last successful output.
