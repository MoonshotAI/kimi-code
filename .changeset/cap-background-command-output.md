---
"@moonshot-ai/agent-core": minor
---

Apply the 16 MiB output cap to background shell commands too, so a runaway background command can no longer fill the disk or crash the process; it is now terminated with the same guidance to redirect large output to a file.
