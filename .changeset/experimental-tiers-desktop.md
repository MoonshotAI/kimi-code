---
"kimi-code-app": minor
---

Split Settings > Lab into `Beta` (`Context usage` and `Prompt prediction`, with an `Enable all Beta features` switch) and `Experimental` (`Progress updates`, `Session mentions`, `Tabbed session list`, and `Tower multi-agent mode`), store Desktop Lab toggles under `[experimental.desktop]` in `config.toml` (isolated from CLI `[experimental.cli]` and login-shell `KIMI_CODE_EXPERIMENTAL_*` exports) with automatic migration from legacy `localStorage`, and scope `KIMI_CODE_EXPERIMENTAL_FLAG=1` to `Beta` features.
