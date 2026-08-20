---
"@moonshot-ai/agent-core-v2": patch
---

Rework the session title excerpts: rebalance the segment budgets toward user prompts (400 chars each, assistant 300), cap each prompt in the `user_prompts` excerpt, and compose the `digest` excerpt from the full conversation arc — every natural-language user prompt in the live window paired with its own turn's final assistant text, interleaved chronologically, within per-segment caps and a 3000-char total budget (middle turns elided).
