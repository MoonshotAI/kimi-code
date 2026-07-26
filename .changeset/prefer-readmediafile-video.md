---
"@moonshot-ai/kimi-code": patch
---

feat(agent): prefer ReadMediaFile for video analysis in system prompt

Updated the system prompt (`system.md`) to explicitly guide the AI to
use `ReadMediaFile` directly for video analysis, rather than writing
Python scripts to extract frames. This leverages the built-in video
input capability of supported models and avoids unnecessary overhead.
