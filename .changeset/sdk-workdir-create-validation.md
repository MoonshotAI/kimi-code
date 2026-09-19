---
"@moonshot-ai/kimi-code-sdk": patch
---

`createSession` and the session-less workspace queries (`listWorkspaceSkills`, `suggestFiles`, `getWorkspaceTrustInfo`, `trustWorkspace`, `listWorkspaceMcpServers`) now reject a missing or non-directory `workDir` with `fs.path_not_found` instead of silently registering it as a workspace.
