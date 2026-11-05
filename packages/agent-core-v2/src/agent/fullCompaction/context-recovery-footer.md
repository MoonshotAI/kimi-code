## Context Recovery
Everything before this note is still on disk in this agent's event log (read-only, append-only):
  ${wire_path}
${window_lines}
If you need exact command output, file contents, error text, or the wording of an earlier request, look it up there instead of guessing. How to read it:
- Layout: one file per agent. agents/main/ is the main agent; each subagent has its own agents/<agentId>/wire.jsonl. A parent's log holds only the Agent tool call and the subagent's returned result — the subagent's own steps are in its own file.
- Format: one JSON record per line, append-only; `type` says what it is. The conversation is in `context.append_message` (user prompts) and `context.append_loop_event` (event.type: step.begin | content.part [text|think] | tool.call | tool.result | step.end). Every other type (llm.request, usage.record, token_counting.measured, metadata, profile.bind, …) is bookkeeping — skip it.
- Boundaries: `context.apply_compaction` marks a compaction (older lines stay in the file; grep for it to find exact boundaries). `context.undo` count=N retracts the previous N messages — treat retracted content as never having happened. `context.clear` resets the conversation.
- Externalized content: tool results over 50k chars may contain a `task_id` for direct TaskOutput retrieval or an `output_path` for bounded Bash reads; check the preservation notice before assuming the file contains everything. Media parts are blob references, not inline.
- Reading: lines are long JSON (often 10k+ chars). Use `rg -n` to find a keyword, then `sed -n 'Np' wire.jsonl` to read exactly that line. To pull one field with real newlines: sed -n 'Np' wire.jsonl | jq -r '.event.result.output'. Prefer individual records over large ranges.
