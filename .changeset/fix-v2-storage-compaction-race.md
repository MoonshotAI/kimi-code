---
"@moonshot-ai/kimi-code": patch
---

Fix a storage race in the experimental v2 engine that could fail value reads when writes overlap with compaction.
