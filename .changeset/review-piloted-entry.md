---
"@moonshot-ai/agent-core": minor
"@moonshot-ai/kimi-code-sdk": minor
"@moonshot-ai/kimi-code": minor
---

`/review` now runs as a piloted, two-turn agent flow: the main agent studies the changes and proposes the review directions, then calls a `RunCodeReview` tool to fan out the reviewers. The static "Review perspectives" confirmation dialog is gone, and the review now lives in the conversation (so it persists and replays).
