---
"@moonshot-ai/pi-tui": patch
---

Make the viewport anchor follow content when lines above the viewport are added or removed, instead of pinning a buffer row index that let the visible window drift and lose rows.
