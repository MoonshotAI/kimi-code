---
"@moonshot-ai/agent-core": patch
---

Cap the output a single foreground shell command may stream so a runaway command can no longer crash the process. A command that produces a very large or unbounded amount of output (e.g. `b3sum --length 18446744073709551615`) previously grew the live-output buffer until Node aborted with a JavaScript heap out-of-memory error; it is now gracefully terminated once its output exceeds 16 MiB, and the result explains how to redirect large output to a file instead. The per-task output ring buffer is also maintained in O(1) per chunk rather than O(n²). Background tasks are unaffected.
