---
"@moonshot-ai/kimi-code": minor
---

External hooks can now return structured `hookSpecificOutput` instructions: `additionalContext` on SessionStart injects model-visible context without showing it in the UI, `updatedInput` on PreToolUse replaces the tool call's input before checks and execution, `updatedToolOutput` on PostToolUse replaces the tool result, and the Stop payload now carries `response_text`, `transcript_path`, and `stop_hook_active`.
