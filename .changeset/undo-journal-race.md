---
"@moonshot-ai/agent-core-v2": patch
---

Undo no longer fails with `Wire journal changed while the undo switch triple was appended` when another record is written to the session journal while the undo reads it. The branch switch now reads again until nothing was written or queued during the read, so its three records land on the lines it computed, and the check after writing looks only at those lines, so a record written right after them no longer fails the undo. Before, a failed undo had already written its records: the journal on disk had the turn undone while the running session still showed it.
