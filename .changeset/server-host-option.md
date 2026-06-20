---
"@moonshot-ai/kimi-code": patch
---

Add a `--host` option to `kimi web` and `kimi server run` so the server can bind to a specific IP or `0.0.0.0` for LAN/remote access. The default remains `127.0.0.1` (loopback) for backward compatibility and security.
