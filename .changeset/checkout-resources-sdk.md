---
"@moonshot-ai/kimi-code-sdk": patch
---

Resolve file suggestions and skills in the active working directory. `getWorkspaceAdditionalDirs(workDir)` returns the effective directories of the implicit project at that path, including the checkout’s local configuration. A resumed session exposes its own project’s directories in `session.summary.additionalDirs`.
