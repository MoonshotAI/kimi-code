---
"@moonshot-ai/acp-adapter": patch
---

ACP: pre-check `/undo [count]` availability against the live context before calling the kernel, mirroring the web backend's `canUndoHistory` guard. An over-large count (or one crossing a compaction boundary) is now refused up front with the kernel's own message wording, instead of the kernel partially deleting history and only then throwing `REQUEST_INVALID`.
