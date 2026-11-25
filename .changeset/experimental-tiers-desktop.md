---
"kimi-code-app": minor
---

Split Settings > Lab into `Beta` (with an `Enable all Beta features` switch) and `Experimental` sections, unify `context_inspector` and `session_mentions` into `[experimental]` in `config.toml` with automatic migration from legacy `localStorage`, move `Tabbed session list` to Settings > General, scope `KIMI_CODE_EXPERIMENTAL_FLAG=1` to `Beta` features, and stop enabling the `WaitFor` tool by default; restore `WaitFor` via `[experimental] wait_for = true` or `KIMI_CODE_EXPERIMENTAL_WAIT_FOR=1`.
