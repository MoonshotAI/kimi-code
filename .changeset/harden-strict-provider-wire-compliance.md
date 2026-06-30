---
"@moonshot-ai/kimi-code": patch
---

Harden strict-provider (Anthropic) wire compliance so a malformed message history can no longer permanently brick a session:

- Close a mid-history tool call whose result is missing entirely (e.g. left behind by an interrupt or undo) instead of sending it open, so a strict-provider 400 can no longer re-fire on every send.
- Drop empty and whitespace-only text blocks before sending, fixing the HTTP 400 ("text content blocks must contain non-whitespace text") that otherwise sticks a session (e.g. an image-only message or a background task completing mid-input).
- As a last resort, if the provider still rejects the request structure — tool_use/tool_result pairing, empty/whitespace text, a non-user first message, or non-alternating roles — resend the request once with a strictly wire-compliant rebuild (every open call closed, stray results dropped, leading non-user messages trimmed, consecutive assistant turns merged).
- Log and report (telemetry) every repair the projector applies to the outgoing request, plus the strict-resend outcome, so a silently-mangled session always leaves a trace for diagnosis.
