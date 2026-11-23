---
"@moonshot-ai/agent-core-v2": patch
---

Harden statically read-only Bash approval by rejecting recursive grep, glob and tilde expansion, tracking Bash cwd, resolving symlinks and guarding option-embedded file reads, while falling back to approval when these checks cannot prove safety.
