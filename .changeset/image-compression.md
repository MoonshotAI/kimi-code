---
"@moonshot-ai/kimi-code-sdk": minor
"@moonshot-ai/kimi-code": minor
---

Automatically compress oversized images before they reach the model. Whatever the source — pasted into the CLI, uploaded from the web/desktop client, sent over ACP, read via `ReadMediaFile`, or returned by an MCP tool — images are downsampled (longest edge ≤ 2000px) and re-encoded to fit a per-image byte budget, cutting vision-token cost and avoiding provider image-size errors. Screenshots stay lossless PNG and only degrade to JPEG when the byte budget cannot otherwise be met. Compression runs as an input-stage step at each ingestion point (while the content part is built), and guards against decompression bombs by skipping absurdly large pixel/byte payloads before decoding. Best-effort: if it fails for any reason the original image is sent unchanged.
