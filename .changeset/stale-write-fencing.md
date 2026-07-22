---
"@moonshot-ai/kimi-code": patch
---

Each agent now tracks its own file-read baselines and refuses to overwrite files that changed on disk after its last read.
