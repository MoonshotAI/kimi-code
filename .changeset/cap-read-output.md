---
"@moonshot-ai/kimi-code": patch
---

A single file read by the agent now returns at most 100,000 characters or about 25,000 tokens, whichever comes first, instead of up to 500,000 characters; set `max_chars` under `[read]` in config.toml to raise both limits again.
