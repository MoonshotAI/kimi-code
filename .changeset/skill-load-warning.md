---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
---

Surface a warning when a skill file fails to parse at session start, instead of dropping it silently. The warning names the offending file and appears in the TUI status line.
