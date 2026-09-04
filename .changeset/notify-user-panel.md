---
"@moonshot-ai/kimi-code": minor
---

Add the experimental `NotifyUser` tool so the model can show you short progress updates while it is still working. The updates of the current turn stack up in an `Update` panel above the input box; press `Ctrl+N` to page back through earlier ones, and the panel closes when the next turn starts. TUI only; enable it with `KIMI_CODE_EXPERIMENTAL_NOTIFY_USER=1` or `[experimental] notify_user = true` in `config.toml`.
