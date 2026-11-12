---
"@moonshot-ai/kimi-code": patch
---

Keep full SSH host management and let each SSH host use its own Kimi login. A host signs in through a code confirmed in the browser of the connecting computer and renews its login itself, so remote agents keep working while that computer sleeps or goes offline; a host where `kimi login` was already run uses that login.
