---
"@moonshot-ai/kimi-code": minor
---

Add the experimental remote-environment TUI surface: an `/environment` dialog to list, add, switch, and reconnect environments (remote cwd validated server-side, handshake failures shown inline), a footer slot showing the bound remote environment ahead of the cwd (error-colored with a notice when disconnected, local git slot hidden), the session's environment identifier on approval panels, `@` file completion served by the session's bound environment on remote sessions, and the codebase attachment option hidden for remote sessions in `/feedback`. Enable with `KIMI_CODE_EXPERIMENTAL_REMOTE_RUNTIME=1`.
