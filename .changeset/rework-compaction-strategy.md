---
"@moonshot-ai/kimi-code": minor
---

Rework conversation compaction:

- Keep only recent user prompts plus a single user-role summary; drop assistant and tool messages.
- Repair tool_use/tool_result adjacency before sending, fixing a strict-provider HTTP 400 when a tool call and its result became non-adjacent.
- Close a mid-history tool call whose result is missing entirely (e.g. left behind by an interrupt or undo) instead of sending it open, so a strict-provider 400 can no longer permanently brick a session.
- Drop empty and whitespace-only text blocks before sending, fixing the strict-provider HTTP 400 ("text content blocks must contain non-whitespace text") that otherwise permanently sticks a session (e.g. an image-only message or a background task completing mid-input).
- As a last resort, if the provider still rejects the request structure — tool_use/tool_result pairing, empty/whitespace text, a non-user first message, or non-alternating roles — resend the request once with a strictly wire-compliant rebuild (every open call closed, stray results dropped, leading non-user messages trimmed, consecutive assistant turns merged).
- Log and report (telemetry) whenever the projector has to repair the outgoing history — a result moved back next to its call, a missing result synthesized, a stray result dropped, a leading non-user message trimmed, or consecutive assistants merged — so a silently-mangled session leaves a trace instead of being papered over.
- Merge consecutive user turns for strict providers (Gemini/Vertex), fixing an HTTP 400 ("roles must alternate") after compaction or when a turn is steered in right after a tool result.
- Micro-compaction now defaults off.
