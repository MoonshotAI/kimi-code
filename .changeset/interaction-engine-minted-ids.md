---
"@moonshot-ai/agent-core-v2": patch
---

Mint interaction ids engine-side (`approval_<uuid>` / `question_<uuid>` / `user_tool_<uuid>`) instead of deriving them from the provider's toolCallId. Self-hosted endpoints may repeat tool call ids across responses, and a repeated id was silently dropped by client-side pending-interaction dedupe (approval prompt never shown, turn parked forever) and could overwrite a same-id pending interaction in the kernel; the provider id stays on the payload for correlation.
