---
"@moonshot-ai/kosong": patch
"@moonshot-ai/kimi-code": patch
---

fix: set Kimi temperature to 0.6 when thinking is disabled

The Kimi API requires temperature=0.6 when thinking is disabled; without
it, toggling thinking off causes a 400 error with "invalid temperature: only
0.6 is allowed". This fix applies the default only when no explicit
temperature has been configured, preserving user overrides (e.g., via
ProviderConfig or env var).

Fixes #686.
