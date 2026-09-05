## Context Recovery
Everything before this note is still on disk in this agent's event log (read-only, append-only):
  ${wire_path}
${window_lines}
If you need exact command output, file contents, error text, or the wording of an earlier request, look it up there instead of guessing. How to read it:
- Layout: one file per agent. agents/main/ is the main agent; each subagent has its own agents/<agentId>/wire.jsonl. A parent's log holds only the Agent tool call and the subagent's returned result — the subagent's own steps are in its own file.
- Format: one JSON record per line, append-only; `type` says what it is. The conversation is in `context.append_message` (user prompts) and `context.append_loop_event` (event.type: step.begin | content.part [text|think] | tool.call | tool.result | step.end). Every other type (llm.request, usage.record, token_counting.measured, metadata, profile.bind, …) is bookkeeping — skip it.
- Boundaries: `context.apply_compaction` marks a compaction (older lines stay in the file; grep for it to find exact boundaries). `context.undo` count=N retracts the previous N messages — treat retracted content as never having happened. `context.clear` resets the conversation.
- Externalized content: tool results over 50k chars are stored truncated, with an `output_path` to a tool-results/*.txt file holding the full text. Media parts are blob references, not inline.
- Reading: lines are long JSON (often 10k+ chars). Grep the file for a keyword to get line numbers, then Read exactly that line (line_offset=N, n_lines=1) — Read returns wire.jsonl lines whole up to ~150k chars. To pull one field with real newlines: sed -n 'Np' wire.jsonl | jq -r '.event.result.output'. Never Read large ranges — a handful of records can exceed the per-call byte cap.
