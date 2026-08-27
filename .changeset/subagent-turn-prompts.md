---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/transcript": patch
---

Carry the orchestrator's prompt on subagent turns: `isDisplayablePromptOrigin` now accepts `system_trigger/subagent`, so live `turn.started` events include the prompt, and cold rebuild folds the opening input (text and attachments) into turns opened by subagent run messages. Other system triggers (goal_continuation, stop_hook, loadable-tools) remain promptless.
