---
"@moonshot-ai/kimi-code": patch
---

Fix file watching on macOS so reloads no longer hang when a watched path does not exist yet. Watches that still fail now settle as ready and keep retrying in the background instead of blocking their consumer indefinitely.
