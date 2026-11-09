---
"@moonshot-ai/kimi-code": patch
---

Outside SSH and mosh, copying now goes only to the system clipboard instead of also through the terminal (OSC 52); set `KIMI_CODE_CLIPBOARD_OSC52=1` to keep the old behavior.
