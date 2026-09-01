---
"@moonshot-ai/kimi-code": patch
---

Honor explicit `[experimental]` config entries over the `KIMI_CODE_EXPERIMENTAL_FLAG` master switch, so a flag set to `false` in `config.toml` stays off; per-feature `KIMI_CODE_EXPERIMENTAL_<NAME>` variables still override both.
