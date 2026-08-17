---
"@moonshot-ai/kimi-code": patch
---

Persist the token counting ledger (`token_counting.measured` / `truncated` / `rebased`) to the wire journal, so the displayed context size keeps its measured value after archiving and unarchiving a session (or any close → resume) instead of dropping to a smaller estimate until the next LLM call.
