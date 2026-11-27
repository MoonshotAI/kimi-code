---
"@moonshot-ai/remote-control": patch
---

On filesystems that support hard links, processes running this version can no longer end up holding the Remote Control machine lock together. The lock record is written to a temporary file and hard-linked into place, so other processes never see it empty or half written. A stale lock is removed only by the process that holds the reclaim marker for that exact record, and only after it re-reads the lock and still finds that record. An abandoned marker is passed over by creating a deeper marker instead of being deleted, and a takeover that fails midway keeps its marker. Inspecting the lock no longer deletes it, and read errors other than a missing file are reported instead of being treated as a stale lock. When a hard link cannot be created, the lock falls back to the previous in-place write without this guarantee. Lock files written by earlier versions keep the same format.
