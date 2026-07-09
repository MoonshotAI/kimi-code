---
"@moonshot-ai/kimi-code": patch
---

Cap model-initiated image reads (ReadMediaFile default reads) at a 256 KB per-image byte budget so sessions that keep screenshotting stay within provider request-size limits, adjustable via `[image] read_byte_budget` in config.toml or the `KIMI_IMAGE_READ_BYTE_BUDGET` environment variable; explicit `region` / `full_resolution` reads keep the provider-scale limit for full-fidelity detail readback, and the compression ladder now steps down to 256px so small budgets always converge.
