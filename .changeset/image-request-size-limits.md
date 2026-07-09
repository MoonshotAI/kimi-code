---
"@moonshot-ai/kimi-code": patch
---

Keep image-heavy sessions within provider request-size limits: model-read images now honor a 256 KB per-image budget and a 2000px downscale cap (configurable via `[image]` in config.toml or `KIMI_IMAGE_*` env vars), oversized WebP is compressed as well, HEIC/HEIF reads are refused with a platform-matched conversion command instead of poisoning the session, and a request-too-large rejection (HTTP 413) now recovers automatically — the request and /compact both retry with older media replaced by text markers instead of failing the session.

