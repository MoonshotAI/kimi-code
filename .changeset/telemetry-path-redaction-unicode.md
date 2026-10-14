---
"@moonshot-ai/kimi-code": patch
---

Redact non-ASCII, UNC, and forward-slash file paths from outbound telemetry. Telemetry strings are now cleaned line by line, and only a single line longer than 8192 characters is replaced with an oversized-line marker instead of the whole value.
