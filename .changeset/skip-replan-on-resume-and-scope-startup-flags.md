---
"@moonshot-ai/kimi-code": patch
---

Skip re-entering plan mode when resuming a session that is already in plan mode (previously failed with "Already in plan mode"), and stop re-applying `--auto`/`--yolo`/`--plan` startup flags when switching sessions through the `/sessions` picker.
