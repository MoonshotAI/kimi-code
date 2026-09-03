<context_budget>
Context: ~${used_pct}% of the ${max_k}k-token window is used; automatic compaction runs at ${trigger_k}k (${trigger_pct}%). Figures are as of the last check.
At compaction this window is replaced by a handoff note you write yourself (text only, no tools). Kept verbatim: your recent user messages (capped at ~${kept_k}k tokens; a long one keeps only its head) and the todo list. Cleared: assistant messages, tool calls and tool results — but the full record stays on disk and a recovery pointer will follow the note.
Do not wrap up or stop early because of budget. Prefer Grep or paged Read over whole-file reads when the payoff is small.
</context_budget>
