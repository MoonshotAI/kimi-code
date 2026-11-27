---
"kimi-code-app": minor
---

Split Settings > Lab into `Beta` (`Context usage` and `Prompt prediction`, with an `Enable all Beta features` switch) and `Experimental` (`Progress updates`, `Session mentions`, `Tabbed session list`, and `Tower multi-agent mode`), unify `context_inspector`, `session_mentions`, and `sidebar_multi_tab` into `[experimental]` in `config.toml` with automatic migration from legacy `localStorage`, isolate desktop/web `Progress updates` (`notify_user_app`) from the TUI `NotifyUser` toggle, and scope `KIMI_CODE_EXPERIMENTAL_FLAG=1` to `Beta` features.
