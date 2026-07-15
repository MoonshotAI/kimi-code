---
"@moonshot-ai/agent-core": minor
"@moonshot-ai/kimi-code-sdk": minor
"@moonshot-ai/acp-adapter": minor
---

ACP: add the `kimi/session/steer` extension method — it injects a pending user message into the session's active turn (consumed at the next step boundary, in-flight tool calls and subagents undisturbed) and resolves `{ steered: false, reason: 'no_active_turn' }` instead of erroring when no turn is running, so clients can fall back to `session/prompt`. Also route `kimi/session/fork` through the same kaos pair as `session/new` when the client advertises fs capabilities: the kernel gains `forkSessionWithOverrides` and the SDK a matching `forkSessionWithKaos` passthrough, so forked sessions keep routing file I/O to the ACP client instead of silently falling back to the kernel's local filesystem.
