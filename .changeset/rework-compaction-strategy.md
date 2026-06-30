---
"@moonshot-ai/kimi-code": minor
---

Rework conversation compaction:

- Keep only recent user prompts plus a single user-role summary; drop assistant and tool messages.
- Repair tool_use/tool_result adjacency before sending, fixing a strict-provider HTTP 400 when a tool call and its result became non-adjacent.
- Close a mid-history tool call whose result is missing entirely (e.g. left behind by an interrupt or undo) instead of sending it open, so a strict-provider 400 can no longer permanently brick a session.
- As a last resort, if the provider still rejects tool_use/tool_result pairing, resend the request once with a strictly wire-compliant rebuild (every open call closed, stray results dropped).
- Log and report (telemetry) whenever the projector has to repair the outgoing history — a result moved back next to its call, a missing result synthesized, or a stray result dropped — so a silently-mangled session leaves a trace instead of being papered over.
- Micro-compaction now defaults off.
