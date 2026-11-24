---
"@moonshot-ai/kimi-code": patch
---

Fix `kimi acp` ending a failed turn silently; the editor now receives the error, such as a rejected model request or the per-turn step limit being reached.
