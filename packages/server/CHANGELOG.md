# @moonshot-ai/server

## 0.2.4

### Patch Changes

- Updated dependencies [[`b905dd4`](https://github.com/MoonshotAI/kimi-code/commit/b905dd49108c567d0fecd38a096808c121672795), [`bf35f63`](https://github.com/MoonshotAI/kimi-code/commit/bf35f63c5d9b53625f3bf04f50b9a0bb49ced2c9), [`e47ca10`](https://github.com/MoonshotAI/kimi-code/commit/e47ca10267e75d0b462f9f54e1ae6fc188521703)]:
  - @moonshot-ai/protocol@0.3.2
  - @moonshot-ai/agent-core@0.15.0

## 0.2.3

### Patch Changes

- [#1231](https://github.com/MoonshotAI/kimi-code/pull/1231) [`ceb27f5`](https://github.com/MoonshotAI/kimi-code/commit/ceb27f5e449e177493f320d90e292487a8fc3410) - Add a server-side key-value store API for persisting web UI preferences to the user's data directory.

- Updated dependencies [[`ceb27f5`](https://github.com/MoonshotAI/kimi-code/commit/ceb27f5e449e177493f320d90e292487a8fc3410), [`a3f9cec`](https://github.com/MoonshotAI/kimi-code/commit/a3f9cec8a975f11e37e992e42f954789ed394207)]:
  - @moonshot-ai/protocol@0.3.1
  - @moonshot-ai/agent-core@0.14.3

## 0.2.2

### Patch Changes

- [#1135](https://github.com/MoonshotAI/kimi-code/pull/1135) [`bf51fb7`](https://github.com/MoonshotAI/kimi-code/commit/bf51fb7a105b2f34a59ed4e83d2588e790cfb086) - Fix the local server failing to start on Windows after the first run because the persistent token file's synthesized mode was rejected as too permissive.

- [#1128](https://github.com/MoonshotAI/kimi-code/pull/1128) [`0886bff`](https://github.com/MoonshotAI/kimi-code/commit/0886bff2bcd3aed954990c948201d84787c0f3f3) - Add a --allowed-host flag to kimi server run that lets extra Host header values pass the DNS-rebinding check, and include allow guidance in the 403 error message. Pass --allowed-host <host> to allow an extra host.

- Updated dependencies [[`76c643b`](https://github.com/MoonshotAI/kimi-code/commit/76c643bcb6da447c8c47728b4f58512a7a11cfa6)]:
  - @moonshot-ai/agent-core@0.14.1

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
