---
"@moonshot-ai/kimi-code": minor
---

Replace the `kimi server` command tree with `kimi web`: the server runs in the foreground (the background daemon and OS-service lifecycle commands are removed), and multiple servers can now share one home directory, each taking the next free port. Manage instances with `kimi web kill [server-id|all]`, `kimi web ps`, and `kimi web rotate-token`; any `kimi server …` invocation prints a deprecation notice and exits 1.
