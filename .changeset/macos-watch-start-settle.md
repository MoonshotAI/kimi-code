---
"@moonshot-ai/agent-core-v2": patch
---

On macOS, emit one root invalidation shortly after a native file watch starts, so changes made while the FSEvents stream is still starting are no longer lost.
