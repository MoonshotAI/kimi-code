---
"@moonshot-ai/kimi-code": patch
---

Stop rendering the image-compression note as raw `<system>` text in the conversation. The caption that prompt ingestion places next to a compressed image is now split out when the user message is stored and delivered through the hidden system-reminder injection instead, so session replay, the web UI, and session titles show only what the user actually typed — while the model still receives the full note (original dimensions, byte size, and readback path).
