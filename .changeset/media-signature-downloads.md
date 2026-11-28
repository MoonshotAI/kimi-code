---
"@moonshot-ai/kap-server": patch
---

Add a session-scoped media-signature endpoint and accept a short-lived `signature` query parameter on workspace file downloads, so media elements can stream files with range requests without bearer headers.