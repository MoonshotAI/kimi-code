---
"@moonshot-ai/agent-core": minor
"@moonshot-ai/kimi-code-sdk": minor
"@moonshot-ai/kimi-code": minor
---

Add experimental goal mode for longer tasks that need more than one turn.

Turn on the feature flag, then start a goal from the TUI with `/goal <objective>`:

```sh
KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1 kimi
```

```text
/goal Fix the failing checkout test
```

Kimi keeps working across turns and shows progress in the TUI, so you can follow the task as it moves forward.

This feature is still experimental. Try it and tell us what would make it more useful.
