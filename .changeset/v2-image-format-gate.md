---
"@moonshot-ai/kimi-code": patch
---

v2 engine: block unsupported image formats (AVIF, HEIC, BMP, TIFF, ICO) at every ingestion point so they can no longer poison session history, and auto-recover provider image-format rejections with a media-stripped resend.
