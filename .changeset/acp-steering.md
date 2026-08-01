---
"@moonshot-ai/kimi-code": minor
---

Expose steering over ACP: map the `_session/steering` extension method to the existing `Session.steer()` in the core SDK.

The `AcpServer.initialize()` response now advertises `_meta.steering.supported: true` so ACP clients can detect the capability at runtime. When a client calls `_session/steering` with a `sessionId` and `prompt` blocks during an active turn, the adapter converts the blocks and injects them into the running turn via `Session.steer()`. If no turn is active, the adapter returns `{ outcome: 'noActiveTurn' }` so the host can fall back to a regular `session/prompt` instead of starting a detached turn.
