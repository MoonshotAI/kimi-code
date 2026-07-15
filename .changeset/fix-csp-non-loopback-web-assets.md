---
"@moonshot-ai/kimi-code": patch
---

Fix the Content-Security-Policy on non-loopback server binds blocking the web UI's theme bootstrap script and bundled fonts, and tighten the policy with explicit form-action, base-uri, and frame-ancestors directives.
