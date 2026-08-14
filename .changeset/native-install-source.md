---
"@moonshot-ai/kimi-code": patch
---

fix(cli): make native install source description platform-aware

On macOS, script installs via the official install.sh are detected as
"native" but the message hardcoded "native (windows). Auto-update is not
supported on this platform." even though native non-Windows installs do
support auto-update. Show "native (windows)" only on win32 and just
"native" elsewhere.
