---
"@moonshot-ai/kimi-code": patch
---

Prevent turns from failing on context overflow after many large tool outputs in one step; oversized Read results may now be saved to a file with a pointer instead of always shown inline, and models without a declared context window now compact conservatively instead of never compacting.
