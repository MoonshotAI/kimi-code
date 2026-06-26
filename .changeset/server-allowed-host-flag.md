---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/server": patch
---

Add a --allowed-host flag to kimi server run that lets extra Host header values pass the DNS-rebinding check, and include allow guidance in the 403 error message. Pass --allowed-host <host> to allow an extra host.
