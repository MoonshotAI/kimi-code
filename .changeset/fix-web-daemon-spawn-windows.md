---
"@moonshot-ai/kimi-code": patch
---

Fix `kimi web` and `/web` failing to start the background server daemon on Windows with `spawn EFTYPE` when the CLI is installed via npm/pnpm or run from source. The official single-binary install script was not affected.
