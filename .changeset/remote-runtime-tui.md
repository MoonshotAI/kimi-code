---
"@moonshot-ai/kimi-code": minor
---

Add the experimental remote-runtime TUI surface: a `/runtime` dialog to list, add, switch, and reconnect runtimes (remote cwd validated server-side, handshake failures shown inline), a footer slot showing the bound remote runtime ahead of the cwd (error-colored with a notice when disconnected, local git slot hidden), the session's environment identifier on approval panels, `@` file completion served by the session's bound runtime on remote sessions, and the codebase attachment option hidden for remote sessions in `/feedback`. Enable with `KIMI_CODE_EXPERIMENTAL_REMOTE_RUNTIME=1`.
