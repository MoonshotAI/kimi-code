---
"@moonshot-ai/kimi-code": minor
---

Hold prompts submitted while an agent is busy in a server-side queue that clients follow through the `queue` WebSocket frame and can pause, resume and reorder; settings sent with a queued prompt now apply when it starts instead of mid-turn, and queued prompts are lost when the server restarts.
