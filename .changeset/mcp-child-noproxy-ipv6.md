---
"@moonshot-ai/kimi-code": patch
---

Fix spawned child processes (e.g. stdio MCP servers) receiving a bracketed `[::1]` entry in `NO_PROXY`, which crashes Python httpx-based MCP servers with `Invalid port: ':1]'` whenever a proxy is configured; the child env now carries the unbracketed loopback list while the in-process dispatcher keeps the bracketed form needed by undici.
