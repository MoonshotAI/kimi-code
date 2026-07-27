# @moonshot-ai/protocol

## 0.5.0

### Minor Changes

- [#1735](https://github.com/MoonshotAI/kimi-code/pull/1735) [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6) Thanks [@7Sageer](https://github.com/7Sageer)! - Support custom agents defined as Markdown files with frontmatter, usable as the main agent or a sub-agent (v2 engine only).

- [#1735](https://github.com/MoonshotAI/kimi-code/pull/1735) [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6) Thanks [@7Sageer](https://github.com/7Sageer)! - Add global tool gating to constrain which tools agents may use, with a per-session override (v2 engine only).

### Patch Changes

- [#2005](https://github.com/MoonshotAI/kimi-code/pull/2005) [`a3699dd`](https://github.com/MoonshotAI/kimi-code/commit/a3699dd6aa7b41efd3129a117007d195282379fd) Thanks [@7Sageer](https://github.com/7Sageer)! - Add an `active` flag to each tool in the server's tool listing API.

## 0.4.0

### Minor Changes

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Track the agent's live phase (idle, running, streaming, tool call, retrying, awaiting approval, interrupted, ended) as a single model field driven by the existing turn events, and carry it on the status update channel for downstream consumers.

### Patch Changes

- [#1630](https://github.com/MoonshotAI/kimi-code/pull/1630) [`0303b82`](https://github.com/MoonshotAI/kimi-code/commit/0303b82c3e691836163ecf906febfb6324c81d74) Thanks [@sailist](https://github.com/sailist)! - Make the server_hello heartbeat_ms field optional so spec-compliant clients no longer reject handshakes from servers that do not advertise a heartbeat interval.

## 0.3.2

### Patch Changes

- [#1258](https://github.com/MoonshotAI/kimi-code/pull/1258) [`b905dd4`](https://github.com/MoonshotAI/kimi-code/commit/b905dd49108c567d0fecd38a096808c121672795) - Show draft pull requests with a distinct draft status instead of displaying them as open.

## 0.3.1

### Patch Changes

- [#1231](https://github.com/MoonshotAI/kimi-code/pull/1231) [`ceb27f5`](https://github.com/MoonshotAI/kimi-code/commit/ceb27f5e449e177493f320d90e292487a8fc3410) - Add a server-side key-value store API for persisting web UI preferences to the user's data directory.

## 0.3.0

### Minor Changes

- [#744](https://github.com/MoonshotAI/kimi-code/pull/744) [`18f299f`](https://github.com/MoonshotAI/kimi-code/commit/18f299fd0b266545a1f7cebae9f58b83b9d9776e) - Add support for legacy SSE MCP servers alongside stdio and streamable HTTP transports.

## 0.2.0

### Minor Changes

- [#612](https://github.com/MoonshotAI/kimi-code/pull/612) [`4603d8a`](https://github.com/MoonshotAI/kimi-code/commit/4603d8ad6e92a303f396f3d79d4e4d212d1c4b14) - Prevent forking sessions during active turns and consolidate wire protocol definitions into a shared internal package.
