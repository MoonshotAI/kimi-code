---
"@moonshot-ai/kimi-code": patch
---

Fix Tower tool calls timing out while waiting for Tower's state or inbox lock when several agents write at the same time. Tower is experimental; enable it with `[experimental] tower = true` in `config.toml` or `KIMI_CODE_EXPERIMENTAL_TOWER=1`.
