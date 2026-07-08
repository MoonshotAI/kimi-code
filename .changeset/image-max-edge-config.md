---
"@moonshot-ai/kimi-code": patch
---

Lower the default image downscale cap from 3000px back to 2000px so multi-image request bodies stay within provider size limits, and make it adjustable via `[image] max_edge_px` in config.toml or the `KIMI_IMAGE_MAX_EDGE_PX` environment variable.
