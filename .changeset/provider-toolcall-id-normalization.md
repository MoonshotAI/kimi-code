---
"@moonshot-ai/agent-core-v2": patch
---

Normalize provider tool call ids at the LLM ingestion boundary (`ToolCallIdNormalizer` in `llmRequester`): self-hosted endpoints may renumber ids per response, and a repeated id corrupted every downstream keying — dropped tool results in context rebuild, `duplicate_tool_call_dropped` in the strict projector, merged transcript frames, misrouted approvals. The first occurrence passes through unchanged; later ones are rewritten to a readable `<id>__<n>` suffix, kept consistent between streamed deltas and the finalized message, logged for provenance, and rolled back when the attempt fails so projection retries re-stream under the same ids. Interaction ids are additionally minted engine-side (`approval_<uuid>` / `question_<uuid>` / `user_tool_<uuid>`) instead of deriving from the provider toolCallId.
