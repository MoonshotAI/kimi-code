---
"@moonshot-ai/kosong": patch
"@moonshot-ai/kimi-code": patch
---

Require an endpoint when importing non-official Anthropic-compatible vendors that lack one: `kimi provider catalog add` (and the TUI import flow) now asks for a base URL instead of silently falling back to the default Anthropic endpoint. `--base-url` now takes precedence over the catalog-declared endpoint, and an empty `--base-url` is rejected instead of persisting a blank endpoint.
