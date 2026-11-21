---
"@moonshot-ai/klient": minor
---

Replace `workspaces.createOrTouch` with `workspaces.resolveImplicit`, which resolves a directory to its implicit project through the core resolver and reports the rule that chose it, and carry the optional `environmentId` and `environmentCwd` of a session on session summaries.
