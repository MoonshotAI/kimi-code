---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": patch
---

Fix `bash_task_timeout_s` being silently ignored when the model omits the per-call `timeout`: the Bash tool's `BashInput.timeout` Zod field no longer carries a `.default(60)` (which made the post-parse `args.timeout !== undefined` check unreachable), and the configured value under `[task]` (v2) or `[background]` (v1) is now honored for both `run_in_background=true` calls and foreground commands auto-detached to the background on timeout.