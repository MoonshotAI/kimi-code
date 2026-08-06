---
"@moonshot-ai/kimi-code": patch
---

Reduce post-compaction task drift: the compaction summary now records whether each earlier request still visible in the conversation was finished, abandoned, or superseded, so the agent no longer restarts long-completed work after auto compaction.
