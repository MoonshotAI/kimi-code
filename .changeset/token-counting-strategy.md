---
"@moonshot-ai/kimi-code": patch
---

Add a `[token_counting]` config section to choose how context token counts are derived: `measured+estimated` (default), `measured` (provider usage only), or `estimated` (heuristic only, for providers without usage reporting). Set `strategy` under `[token_counting]` in config.toml (or `KIMI_TOKEN_COUNTING_STRATEGY`) to switch.
