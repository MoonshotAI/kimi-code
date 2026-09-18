---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/kimi-code-sdk": minor
---

Extend experimental remote environments with the session environment surface: REST endpoints to switch environment with a remote cwd, reconnect explicitly, and list declared environments, matching SDK session methods (`switchEnvironment` with cwd, `reconnectEnvironment`, `listEnvironments`, and `createSession` environment options), project-declared environments with their full command lines in the workspace trust prompt data, and image-compression originals written into the bound environment's tempDir on remote sessions. Enable with `KIMI_CODE_EXPERIMENTAL_REMOTE_RUNTIME=1`.
