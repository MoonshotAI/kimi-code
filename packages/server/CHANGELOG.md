# @moonshot-ai/server

## 0.2.1

### Patch Changes

- [#1085](https://github.com/MoonshotAI/kimi-code/pull/1085) [`f1fad72`](https://github.com/MoonshotAI/kimi-code/commit/f1fad7222ccd3f66c1cae6c5b9c009230227cd2f) - Reduce streaming latency by disabling Nagle's algorithm on WebSocket connections.

- [#1081](https://github.com/MoonshotAI/kimi-code/pull/1081) [`8fc6aa5`](https://github.com/MoonshotAI/kimi-code/commit/8fc6aa5f6842aa78acf8f23912342b721efcf7a9) - Sync session title changes across all connected clients in server mode.

## 0.2.0

### Minor Changes

- [#975](https://github.com/MoonshotAI/kimi-code/pull/975) [`c5c1834`](https://github.com/MoonshotAI/kimi-code/commit/c5c18347251221fab74e4f452ac4910116c4224d) - Speed up session snapshot loading with a direct disk reader and a request timeout safeguard, keeping the previous path as a legacy fallback.

### Patch Changes

- Updated dependencies [[`c0eeca2`](https://github.com/MoonshotAI/kimi-code/commit/c0eeca24692edd736eecd3c2541d7566bac9f80f), [`2730079`](https://github.com/MoonshotAI/kimi-code/commit/27300797f2149900219b05dda49dce65e71fa85a)]:
  - @moonshot-ai/agent-core@0.14.0
