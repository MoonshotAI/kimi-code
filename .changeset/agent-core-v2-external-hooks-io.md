---
"@moonshot-ai/agent-core-v2": minor
---

External hooks parse `hookSpecificOutput.additionalContext`, `updatedInput`, and `updatedToolOutput` from hook stdout with per-field malformed markers and config-order merging. PreToolUse now runs as a native validating-phase tool hook so input rewrites are re-validated and re-prepared before guards and permission checks; PostToolUse awaits hooks and applies output replacement across the native result, prepared result, and truncation. SessionStart additionalContext is delivered to the main agent as a hidden injection-origin reminder through a session-scope stash consumed on agent creation or pushed to an existing agent. The Stop payload gains `response_text` (final assistant text of the ended turn), `transcript_path` (wire journal path after flush), and a truthful `stop_hook_active`.
