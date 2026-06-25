---
"@moonshot-ai/kimi-code": minor
---

Add server authentication and safe `--host` exposure. The local server now
requires a per-start bearer token on all API and WebSocket calls (the CLI reads
it automatically), enforces Host/Origin checks, and gains `--host` with a
public-binding hardening tier: mandatory `KIMI_CODE_PASSWORD`, TLS (or
`--insecure-no-tls`), auth-failure rate limiting, disabled remote
shutdown/terminals, and security response headers. See `packages/server/SECURITY.md`.
