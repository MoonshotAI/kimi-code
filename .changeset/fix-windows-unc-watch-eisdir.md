---
"@moonshot-ai/agent-core-v2": patch
---

Fall back to polling directory watching when native watching fails with EISDIR on Windows UNC roots, preserving non-recursive depth limits and ignore pruning.
