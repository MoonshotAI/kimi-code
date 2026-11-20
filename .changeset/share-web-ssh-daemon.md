---
"@moonshot-ai/kimi-code": minor
---

On macOS and Linux, `kimi web` and `kimi rc` now run on one shared background server that SSH connections also use, so `Ctrl+C` no longer stops it; run `kimi web status` or `kimi web stop` to inspect or stop it, or pass `--no-daemon` to keep a foreground server.
