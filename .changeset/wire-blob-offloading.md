---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
---

Offload large base64 media payloads from wire.jsonl into external blob files to reduce wire size and memory pressure during session replay. Includes an in-memory read-through cache on `BlobStore` so repeated rehydration avoids redundant disk reads.
