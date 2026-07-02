---
"@moonshot-ai/agent-core": patch
---

Drop leading orphan tool results when restoring a session compacted by an older version. The legacy-restore path kept a verbatim tail `history.slice(compactedCount)`; when the compaction cut landed inside a tool exchange, the tail began with a `tool` result whose assistant `tool_call` was summarized away. The normal projection does not repair such a leading orphan, so a strict provider (OpenAI / DeepSeek) rejected every turn with `role 'tool' must be a response to a preceding message with 'tool_calls'`. The restored tail is now trimmed so it is wire-valid from the first turn.
