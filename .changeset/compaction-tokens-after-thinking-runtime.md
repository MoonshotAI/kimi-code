---
"@moonshot-ai/agent-core-v2": patch
---

Estimate the compacted summary size from the retained summary text instead of the provider completion token count whenever thinking is enabled, the compaction reply contains thinking blocks, or the provider omits usage, so discarded reasoning tokens and missing usage no longer skew the post-compaction token count or the rebased token-counting anchor.
