---
"@moonshot-ai/kap-server": patch
"@moonshot-ai/acp-server": patch
---

Server shutdown now waits for the engine to finish disposing its services, so file watchers on the data and workspace directories are closed before shutdown completes.
