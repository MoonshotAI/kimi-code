---
"@moonshot-ai/kimi-code": patch
---

Stop unsupported image formats (AVIF, BMP, TIFF, ICO, …) from breaking sessions: they are now refused with conversion guidance or replaced with a text notice at every entry point, and `image/jpg`-style MIME aliases are normalized, so one such image can no longer make every later request fail.
