---
'@moonshot-ai/acp-server': patch
---

Forward session updates for engine-driven turns that no ACP prompt started, and hold prompts arriving while such a turn runs until their own turn completes instead of settling them immediately with an empty end turn.
