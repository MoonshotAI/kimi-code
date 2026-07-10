---
"@moonshot-ai/kimi-code": patch
---

Stop unsupported image formats (AVIF, BMP, TIFF, ICO, …) from breaking sessions at every entry point — including remote image URLs and images mislabeled by a tool — and recover an already-stuck session by dropping the offending image and retrying, so one such image can no longer make every later request fail.
