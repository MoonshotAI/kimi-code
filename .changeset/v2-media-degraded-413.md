---
"@moonshot-ai/kimi-code": patch
---

v2 engine: recover image-heavy sessions from provider request-size rejections (HTTP 413) by resending with older media degraded to text markers, re-encode oversized WebP images instead of passing them through, and keep downscaled PNGs readable by switching to JPEG below 1000px.
