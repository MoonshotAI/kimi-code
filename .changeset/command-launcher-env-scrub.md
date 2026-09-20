---
"@moonshot-ai/kimi-code": patch
---

Fix command-launcher remote environments leaking the host's environment variables (including LLM API keys) to the executor and every process started through it; only a minimal base set and the entry's declared env are forwarded.
