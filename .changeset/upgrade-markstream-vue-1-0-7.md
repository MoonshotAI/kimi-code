---
"@moonshot-ai/kimi-code": patch
---

web: Upgrade markstream-vue to 1.0.7 to fix garbled line numbers in code blocks. The async code-block loading fallback was unstyled in 1.0.4 (proportional font, code overlapping the line-number gutter) and used an over-estimated reserved height that clipped leading lines; 1.0.6 ships self-contained fallback styles and 1.0.7 fixes the height estimate.
