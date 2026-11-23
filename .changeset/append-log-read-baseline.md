---
'@moonshot-ai/core': patch
---

Record an append log's known length when a read starts instead of after it finishes, so records appended by the same store while a read is streaming are no longer reported as external modifications.
