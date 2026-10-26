---
"@moonshot-ai/kimi-code": patch
---

Fire UserPromptSubmit hooks on goal continuation turns so hooks see every prompt in a goal session; a continuation blocked by a hook now marks the goal blocked instead of stalling it silently.
