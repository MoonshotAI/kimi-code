---
"@moonshot-ai/kimi-code": patch
---

The agent now limits build and test runs to the checks that cover its changes and no longer repeats checks that already passed, including after context compaction; ask for a full run or require one in AGENTS.md to keep the old behavior.
