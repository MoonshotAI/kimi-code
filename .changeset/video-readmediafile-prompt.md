---
"@moonshot-ai/agent-core": patch
---

feat(agent-core): guide AI to use ReadMediaFile for video analysis instead of manual frame extraction

Adds explicit guidance in system prompt to prefer ReadMediaFile tool over writing Python/ffmpeg scripts when analyzing video content.
