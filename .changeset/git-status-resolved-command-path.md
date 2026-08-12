---
"@moonshot-ai/kimi-code": patch
---

Close a Windows binary-planting gap in the footer git status: the git and gh commands used for the branch/dirty badge are now resolved to an absolute PATH location, so an executable planted in an untrusted workspace can no longer run before the workspace trust prompt.
