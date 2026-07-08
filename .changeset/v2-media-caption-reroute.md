---
"@moonshot-ai/agent-core-v2": patch
---

Hide image-compression captions from user-visible history: captions that prompt ingestion places inside a user message are rerouted through hidden system reminders (and stripped from session titles), while the model still receives the full note. ReadMediaFile is now registered in production whenever the bound model supports image or video input, re-registering on model switches.
