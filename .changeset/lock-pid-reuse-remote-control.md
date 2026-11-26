---
"@moonshot-ai/remote-control": patch
---

The machine-wide single-instance lock is now treated as stale when its recorded pid is a zombie, belongs to a process started after the lock was written, predates the current boot, or on Windows no longer owns the named pipe recorded in the optional `liveness` field; previously any live process with the same pid kept the lock held.
