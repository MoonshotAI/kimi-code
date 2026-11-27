---
'@moonshot-ai/agent-core-v2': patch
'@moonshot-ai/kimi-code-sdk': patch
'@moonshot-ai/kap-server': patch
---

Keep withdrawn prompts out of turn-input matching and pair legacy steered follow-ups with their original messages before normalization for restoration, replay, and turn-based forks.
