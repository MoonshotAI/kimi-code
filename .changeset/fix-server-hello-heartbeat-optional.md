---
"@moonshot-ai/protocol": patch
---

Make the server_hello heartbeat_ms field optional so spec-compliant clients no longer reject handshakes from servers that do not advertise a heartbeat interval.
