---
"@moonshot-ai/kimi-code": patch
---

In `kimi -p` runs, wait for background subagents to finish before exiting when `background.keep_alive_on_exit` is enabled. Set `keep_alive_on_exit = true` to let concurrent background subagents complete.
