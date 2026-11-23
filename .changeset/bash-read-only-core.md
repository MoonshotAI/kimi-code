---
"@moonshot-ai/agent-core-v2": patch
---

Harden statically read-only Bash approval by rejecting command substitution, recursive directory reads and indirect file arguments, translating Git Bash paths and falling back to approval when sensitive targets cannot be ruled out.
