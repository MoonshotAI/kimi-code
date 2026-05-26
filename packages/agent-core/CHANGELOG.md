# @moonshot-ai/agent-core

## 0.2.0

### Minor Changes

- [#25](https://github.com/MoonshotAI/kimi-code/pull/25) [`c4dd1c7`](https://github.com/MoonshotAI/kimi-code/commit/c4dd1c7ff298290ee17d4a6676f93284621f32e8) - Flatten tool call data by inlining tool names and arguments at the top level, and limit legacy record migration so it only rewrites matching tool call payloads.

### Patch Changes

- [#22](https://github.com/MoonshotAI/kimi-code/pull/22) [`2004aed`](https://github.com/MoonshotAI/kimi-code/commit/2004aedfe1d4e5e17762108bf48b7b9aa6d4e25b) - Add wire record migration handling during session replay.

- [#24](https://github.com/MoonshotAI/kimi-code/pull/24) [`7858821`](https://github.com/MoonshotAI/kimi-code/commit/7858821f2f1fecc9de666780fc62434ca76dcc82) - Persist model selections from the terminal UI to the default configuration, and honor the configured default thinking state for new sessions.

- [#14](https://github.com/MoonshotAI/kimi-code/pull/14) [`0da6073`](https://github.com/MoonshotAI/kimi-code/commit/0da60730b9716c39a07e8a3a0a320e3af7ad30fa) - Move wire metadata handling into the record layer and keep persistence backends limited to storage operations.

- [#12](https://github.com/MoonshotAI/kimi-code/pull/12) [`89ea895`](https://github.com/MoonshotAI/kimi-code/commit/89ea8959eb9419d04e63645b4d89ca0e33f20d98) - Retry compaction responses that do not contain a summary before updating conversation history.

- [#49](https://github.com/MoonshotAI/kimi-code/pull/49) [`cf2227e`](https://github.com/MoonshotAI/kimi-code/commit/cf2227e8a5222ad9bd1167b573b62599d0efd906) - Resume sessions with a newer wire protocol version instead of failing. A warning is now shown in the TUI and records are replayed without migration.

- [#17](https://github.com/MoonshotAI/kimi-code/pull/17) [`bfbd522`](https://github.com/MoonshotAI/kimi-code/commit/bfbd522a7160e597d673550f09fd4af089bfde34) - Let Kimi requests use the remaining context window for completion tokens by default while keeping explicit environment limits as hard caps.

- Updated dependencies [[`a200a29`](https://github.com/MoonshotAI/kimi-code/commit/a200a297ac8986ec4baa8d2cdc881ef71bc3abfc), [`c4dd1c7`](https://github.com/MoonshotAI/kimi-code/commit/c4dd1c7ff298290ee17d4a6676f93284621f32e8), [`df7a9ca`](https://github.com/MoonshotAI/kimi-code/commit/df7a9cab606e0f152bc45b1d1645d76210b1e0c4)]:
  - @moonshot-ai/kosong@0.2.0
