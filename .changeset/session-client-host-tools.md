---
"@moonshot-ai/kimi-agent": patch
---

Host-facing `createSessionClient`: the phase-D integration point for hosts (print mode, TUI). Hand the engine a step function and a tool table instead of running a turn loop — the engine owns the loop, context, goal driving, and persistence; the client returns a `{ prompt, cancel, save, load }` handle and renders from events. Host tools register at `session/create` (new `tools` param → `AgentOptions.host_tools`) and settle back at the host via `host/execute_tool`. Fixed en route: the standalone agent assembled its tool table (native + goal + MCP + knowledge) and then dropped it (`tool_defs: vec![]`), leaving the model blind to every tool — caught by the new stdio e2e test, which asserts the model actually sees `HostEcho`/`CreateGoal` and the host tool executes with the model's arguments. `KIMI_AGENT_FORCE_STDIO=1` skips the napi fast path for stdio-only surfaces.
