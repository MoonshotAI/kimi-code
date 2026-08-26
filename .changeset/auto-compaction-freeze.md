---
"@moonshot-ai/kimi-code": patch
---

Fix auto compaction being repeatedly cancelled during active turns and goals; the agent now pauses until compaction completes, then resumes.
