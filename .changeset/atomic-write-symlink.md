---
"@moonshot-ai/agent-core": patch
---

fix(fs): preserve symlinks in atomicWrite and writeFileAtomicDurable

Ensure symlinks are preserved when using atomic write operations.
