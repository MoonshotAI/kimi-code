---
"@moonshot-ai/kimi-code": minor
---

Add a Language entry to `/settings` for switching the UI language at runtime. Picking Auto / English / 简体中文 flips the interface immediately (no restart), persists to `tui.toml`, and is re-applied on startup and by `/reload`.
