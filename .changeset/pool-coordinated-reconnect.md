---
"@moonshot-ai/kimi-code": patch
---

Reconnecting a remote environment now replaces the connection shared by every workspace bound to the same target, so all of them move to the fresh connection; work in flight on the old connection fails as it does on a disconnect.
