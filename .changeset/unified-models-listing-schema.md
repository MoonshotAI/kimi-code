---
"@moonshot-ai/kimi-code-oauth": minor
---

Switch managed Kimi Code model listing to the unified /models schema: context length is read from `limit.context`, thinking capabilities from the `reasoning` object (`type: only | both | none`, with optional `effort.valid` / `effort.default`), image/video input from `modalities.input`, and dynamic-tool support from `tools.dynamic_load`. The legacy flat fields (`context_length`, `supports_reasoning`, `supports_image_in`, `supports_video_in`, `supports_thinking_type`, `think_efforts`, `supports_dynamic_tools`) are no longer read, and entries without a positive `limit.context` are rejected.
