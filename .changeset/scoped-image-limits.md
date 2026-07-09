---
"@moonshot-ai/kimi-code": patch
---

Scope `[image]` config limits to the owning core instead of a process-global value, so multiple cores in one process (the SDK's multi-client pattern) each compress images with their own `max_edge_px` / `read_byte_budget`, and a config reload of one core never retunes another; the env vars `KIMI_IMAGE_MAX_EDGE_PX` / `KIMI_IMAGE_READ_BYTE_BUDGET` still override process-wide.
