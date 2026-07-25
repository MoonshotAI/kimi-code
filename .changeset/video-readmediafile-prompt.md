---
"@moonshot-ai/agent-core": patch
---

feat(agent-core): guide AI to use ReadMediaFile for video analysis instead of manual frame extraction

Adds explicit guidance in the system prompt and ReadMediaFile tool description to prefer the `ReadMediaFile` tool over writing Python/ffmpeg scripts when analyzing video content. This prevents inefficient manual frame extraction and leverages built-in multimodal capabilities.
