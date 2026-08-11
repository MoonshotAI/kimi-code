---
"@moonshot-ai/kimi-code": patch
---

Fix a Windows binary-planting risk: child processes spawned by bare command name before the workspace trust prompt (stty, fd detection, package-manager update installs) could resolve to a malicious executable placed in the current directory. These commands are now skipped on Windows, deferred until after the trust prompt, or resolved to an absolute PATH location with hits inside the current directory refused.
