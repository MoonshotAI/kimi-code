<compaction_ahead>
Context is at ~${used_pct}%; automatic compaction runs at ${trigger_pct}% (about ${remaining_k}k tokens from now). When it runs you will write a handoff note with text only — no tool calls. This is your last chance to act:
- persist unfinished intermediate results to files or the todo list — these survive verbatim and can be read back;
- verify with tools any claim you intend to carry forward (run the test; don't assume) — the note will be written with the result in view;
- bring the current sub-task to a hand-off-able boundary; don't start large new work now;
- if a long user input or constraint may be truncated (kept user messages are capped at ~${kept_k}k tokens), restate its essentials.
Then continue the task; do not stop.
</compaction_ahead>
