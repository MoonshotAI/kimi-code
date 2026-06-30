---
"@moonshot-ai/kimi-code-sdk": minor
"@moonshot-ai/kimi-code": minor
---

Automatically compress oversized images before they reach the model. Whatever the source — pasted into the CLI, uploaded from the web/desktop client, sent over ACP, read via `ReadMediaFile`, or returned by an MCP tool — images are downsampled (longest edge ≤ 2000px) and re-encoded to fit a per-image byte budget, cutting vision-token cost and avoiding provider image-size errors. Screenshots stay lossless PNG and only degrade to JPEG when the byte budget cannot otherwise be met. Compression is best-effort: if it fails for any reason the original image is sent unchanged. Handling is centralized in the agent core (at the prompt ingestion point and on tool results), so every client transport is covered uniformly.
