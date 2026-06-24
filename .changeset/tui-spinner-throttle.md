---
"@moonshot-ai/kimi-code": patch
---

Throttle TUI spinner renders to reduce CPU usage during thinking/loading states.

- `ThinkingComponent` now advances its braille animation frame every 80ms but coalesces `requestRender()` calls to ~200ms.
- `MoonLoader` similarly coalesces interval-driven renders to ~200ms while still rendering immediately on label/tip/width/color changes.
