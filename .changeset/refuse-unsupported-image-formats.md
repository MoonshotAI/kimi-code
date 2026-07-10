---
"@moonshot-ai/kimi-code": patch
---

Stop unsupported image formats (AVIF, BMP, TIFF, ICO, …) from breaking sessions: they are now refused with conversion guidance or replaced with a text notice at every entry point, and MIME aliases like `image/jpg` are normalized to the exact canonical data URL providers require, so one such image can no longer make every later request fail.
