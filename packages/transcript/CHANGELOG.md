# @moonshot-ai/transcript

## 0.0.2

### Patch Changes

- [#3289](https://github.com/MoonshotAI/kimi-code/pull/3289) [`f143130`](https://github.com/MoonshotAI/kimi-code/commit/f143130c072e9dba8d60ef40c49d4305b93ab2fe) Thanks [@liruifengv](https://github.com/liruifengv)! - Carry the orchestrator's prompt on subagent turns: `isDisplayablePromptOrigin` now accepts `system_trigger/subagent`, so live `turn.started` events include the prompt, and cold rebuild folds the opening input (text and attachments) into turns opened by subagent run messages. Other system triggers (goal_continuation, stop_hook, loadable-tools) remain promptless.

## 0.0.1

### Patch Changes

- [#1888](https://github.com/MoonshotAI/kimi-code/pull/1888) [`5ae60fa`](https://github.com/MoonshotAI/kimi-code/commit/5ae60fa6736b63b80bd764ef01d6c0334eb80595) Thanks [@sailist](https://github.com/sailist)! - Add a unified, agent-granular transcript rendering data layer and serve it from the v2 server: clients can fetch turn-paginated transcripts via `GET /sessions/{id}/transcript` and subscribe to per-agent transcript updates over the v1 WebSocket with per-connection granularity control (off / turn / block / delta). All transcript wire types are owned by the transcript package itself. `turn.started` now carries the turn's prompt text so live transcripts render the user input as soon as the turn opens.
