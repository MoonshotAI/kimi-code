---
"@moonshot-ai/kimi-code": patch
---

Collapse older assistant messages into the turn's step summary line so long turns stay bounded: a running turn keeps its last 20 messages, and a finished turn keeps only its conclusion tail (last 2). Set KIMI_CODE_TUI_KEEP_RECENT_ASSISTANT and KIMI_CODE_TUI_KEEP_RECENT_ASSISTANT_COMPLETED to tune (0 disables folding).
