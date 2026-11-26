---
"@moonshot-ai/kimi-code": patch
---

Fix automatic compaction being discarded and turns ending as cancelled when `loop_control.compaction_trigger_ratio` is set below 0.85.
