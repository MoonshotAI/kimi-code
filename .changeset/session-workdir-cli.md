---
"@moonshot-ai/kimi-code": patch
---

`kimi -c`, the session picker, `kimi session list`, `kimi fork` and `kimi export` now use only sessions that ran in the current directory, no longer including sessions of desktop projects rooted or registered there; use `kimi session list --all` or `kimi -r <id>` to reach them.
