---
"kimi-code-app": patch
---

Fix the built-in terminal failing on Windows for SSH remote projects by resolving `ssh.exe` to an absolute path before spawning `node-pty`.
