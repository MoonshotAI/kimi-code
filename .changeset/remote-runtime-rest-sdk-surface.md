---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/kimi-code-sdk": minor
---

Extend experimental remote runtimes with the session runtime surface: REST endpoints to switch runtime with a remote cwd, reconnect explicitly, and list declared runtimes, matching SDK session methods (`switchRuntime` with cwd, `reconnectRuntime`, `listRuntimes`, and `createSession` runtime options), project-declared runtimes with their full command lines in the workspace trust prompt data, and image-compression originals written into the bound runtime's tempDir on remote sessions. Enable with `KIMI_CODE_EXPERIMENTAL_REMOTE_RUNTIME=1`.
