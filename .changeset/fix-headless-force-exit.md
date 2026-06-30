---
"@moonshot-ai/kimi-code": patch
---

Force-exit headless runs (`kimi -p`) so a stray ref'd handle left over from the run can't keep a completed run alive until an external timeout, and bound prompt cleanup so a wedged shutdown step can't hang shutdown.
