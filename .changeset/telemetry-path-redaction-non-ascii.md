---
"@moonshot-ai/kimi-code": patch
---

Fix telemetry path redaction leaking home directory names that are not ASCII. Paths under a directory named e.g. `李明`, `иван`, or `josé` were only partially redacted, as were UNC paths and `C:/`-style spellings. The `node_modules/` tail that carries diagnostic value is now also preserved on Windows.
