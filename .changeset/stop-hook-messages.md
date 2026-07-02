---
"@moonshot-ai/kimi-code": patch
---

Stop hook now includes recent `messages` in its payload, enabling external memory systems like Mimir to learn from the current turn.

- Added `messages` field to the `Stop` hook input data, containing the last user/assistant text messages.
- Updated the English and Chinese hook documentation.
- Added a test to verify the payload format.
