---
"@moonshot-ai/kimi-code": minor
---

Replace the `kimi server` command tree with `kimi web`: it runs the local server in the foreground (the background daemon and OS-service lifecycle commands are removed), and multiple servers can now share one home directory, each taking the next free port. Use `kimi web kill [server-id|all]` to stop one instance or every instance (default: the longest-running), `kimi web ps` to list connected clients per server, and `kimi web rotate-token` to rotate the token. Any `kimi server …` invocation now prints a deprecation notice and exits 1 (the notice ships until the next major version).
