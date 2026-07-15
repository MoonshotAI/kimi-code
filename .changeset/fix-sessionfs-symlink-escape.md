---
"@moonshot-ai/kimi-code": patch
---

Fix the session filesystem API following symlinks that point outside the workspace, which allowed reading, listing, creating, and downloading host files beyond the session directory through a planted symlink.
