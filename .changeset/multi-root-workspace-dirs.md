---
"kimi-code": patch
---

Fix the extension ignoring the non-primary folders of a multi-root workspace: they are now passed to the session as additional directories, edits made in them are tracked in File Changes (and can be kept or undone), and a folder added to the workspace mid-conversation reaches the open session instead of waiting for a reload.
