---
"@moonshot-ai/kimi-code": patch
---

Redact private file paths (including Unicode, UNC, Win32 device, and forward-slash Windows paths) from outbound telemetry while preserving surrounding diagnostics within the 8,192-code-unit line cap and 32,768-code-unit value budget; lines or trailing content exceeding those caps are replaced with `<REDACTED: oversized telemetry-line>`.
