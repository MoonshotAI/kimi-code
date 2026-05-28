# @moonshot-ai/agent-core

## 0.4.0

### Minor Changes

- [#157](https://github.com/MoonshotAI/kimi-code/pull/157) [`971fce6`](https://github.com/MoonshotAI/kimi-code/commit/971fce6e528c2b210df1852d7cd12bcda71014fd) - Add scheduled tasks:

  You can now ask the assistant to remind you at a specific time, run a task on a recurring cron schedule (for example, check a deploy every 5 minutes or run a daily report every weekday at 9am), or come back on its own in a few minutes to continue what it was doing.

  Schedules use the standard 5-field cron syntax.

### Patch Changes

- [#120](https://github.com/MoonshotAI/kimi-code/pull/120) [`8515472`](https://github.com/MoonshotAI/kimi-code/commit/85154724764a3478bfc0ef40d8b5a1def5063ec7) - Fix compaction to handle edge cases where no messages are compactable and improve retry logic.

- [#139](https://github.com/MoonshotAI/kimi-code/pull/139) [`50251a1`](https://github.com/MoonshotAI/kimi-code/commit/50251a136093c27c0d69a730b267b746dea47468) - Show file content and diff in Write and Edit approval prompts, and open them in a dedicated full-screen viewer on ctrl+e instead of expanding inline.

- [#117](https://github.com/MoonshotAI/kimi-code/pull/117) [`a6d379b`](https://github.com/MoonshotAI/kimi-code/commit/a6d379b2ceea4bf988517bdf357d1931a1fb1f05) - Offload large base64 media payloads from wire.jsonl into external blob files to reduce wire size and memory pressure during session replay. Includes an in-memory read-through cache on `BlobStore` so repeated rehydration avoids redundant disk reads.

## 0.3.0

### Minor Changes

- [#26](https://github.com/MoonshotAI/kimi-code/pull/26) [`2b74025`](https://github.com/MoonshotAI/kimi-code/commit/2b74025302be9b42e68a15f33333c55d64a6c9e7) - Rework tool permissions: reads outside cwd no longer prompt, session approvals match the exact call, and path-based rules are case-insensitive.

- [#119](https://github.com/MoonshotAI/kimi-code/pull/119) [`ebf6e81`](https://github.com/MoonshotAI/kimi-code/commit/ebf6e8181ea20a0fcf6a609195ccf5b6cc2a665a) - Add user-global plugin installation, interactive plugin management, plugin-provided skills, and plugin-owned MCP servers.

### Patch Changes

- [#105](https://github.com/MoonshotAI/kimi-code/pull/105) [`d599183`](https://github.com/MoonshotAI/kimi-code/commit/d599183c8eccea813d7aa5ddd974e72139cbb63c) - Enhance `kimi export` to include more diagnostic information in the manifest.

- [#119](https://github.com/MoonshotAI/kimi-code/pull/119) [`ebf6e81`](https://github.com/MoonshotAI/kimi-code/commit/ebf6e8181ea20a0fcf6a609195ccf5b6cc2a665a) - Restrict plugin zip installs to manifests at the archive root or a single wrapper directory.

- [#102](https://github.com/MoonshotAI/kimi-code/pull/102) [`6f55f1d`](https://github.com/MoonshotAI/kimi-code/commit/6f55f1d0aff12ce13cea616a1f37e6242beb2ff8) - Route session-tagged log entries exclusively to the session sink instead of duplicating them to the global sink. Consistently omit stable main-agent context keys from all session log lines that carry `agentId=main`.

- [#92](https://github.com/MoonshotAI/kimi-code/pull/92) [`4e458d6`](https://github.com/MoonshotAI/kimi-code/commit/4e458d63643a56a2fb1ba9f908c774e56eef1c75) - Use one retry classification for transient LLM failures across regular turns and compaction.

- [#84](https://github.com/MoonshotAI/kimi-code/pull/84) [`e5717b7`](https://github.com/MoonshotAI/kimi-code/commit/e5717b7261599f4b4379aa34eb0b5fdf2dd93898) - Unify path normalization by replacing ad-hoc `toForwardSlashes` helpers with `pathe`. Remove unnecessary `node:path/win32` branching in path-access policies and tools, and inline unused `joinPath` wrappers. Platform-specific path separators are now handled consistently through a single module.

- Updated dependencies [[`4e458d6`](https://github.com/MoonshotAI/kimi-code/commit/4e458d63643a56a2fb1ba9f908c774e56eef1c75), [`e5717b7`](https://github.com/MoonshotAI/kimi-code/commit/e5717b7261599f4b4379aa34eb0b5fdf2dd93898)]:
  - @moonshot-ai/kosong@0.2.2
  - @moonshot-ai/kaos@0.1.2

## 0.2.1

### Patch Changes

- [#62](https://github.com/MoonshotAI/kimi-code/pull/62) [`e2b2b46`](https://github.com/MoonshotAI/kimi-code/commit/e2b2b46fc9c1d6a0ada67c590b8aa56e77c9c513) - Make `AgentRecords` hold the `Agent` instance directly and inline the restore dispatch logic.

- [#70](https://github.com/MoonshotAI/kimi-code/pull/70) [`d95b013`](https://github.com/MoonshotAI/kimi-code/commit/d95b01342a7921f0863ceb37abad7984d0245509) - Preserve catalog-declared interleaved reasoning fields for OpenAI-compatible models configured through `/connect`.

- [#72](https://github.com/MoonshotAI/kimi-code/pull/72) [`0ce0072`](https://github.com/MoonshotAI/kimi-code/commit/0ce0072cb44ea2bd3a7ca9c54d141c150f0bbb77) - Fix user skills in ~/.agents/ not being loaded.

- [#86](https://github.com/MoonshotAI/kimi-code/pull/86) [`5e354d0`](https://github.com/MoonshotAI/kimi-code/commit/5e354d0cc89816228d08c3ded17e75201fb300de) - Restore real-time token display for running subagents in the TUI.

- [#83](https://github.com/MoonshotAI/kimi-code/pull/83) [`7d9216d`](https://github.com/MoonshotAI/kimi-code/commit/7d9216d5aa1e96734c46c8d5d810ec7ed27b2275) - Always emit a paired tool result when a tool returns a malformed or missing result, preventing the next request from failing with a missing tool_call_id error.

- [#85](https://github.com/MoonshotAI/kimi-code/pull/85) [`2bb50a3`](https://github.com/MoonshotAI/kimi-code/commit/2bb50a38d8379e2fac57547b1a563722f713c8fd) - Avoid overly small local completion caps that can truncate reasoning before summaries are produced.

- Updated dependencies [[`d95b013`](https://github.com/MoonshotAI/kimi-code/commit/d95b01342a7921f0863ceb37abad7984d0245509), [`61f7d0e`](https://github.com/MoonshotAI/kimi-code/commit/61f7d0e7a2b9933bdbe7eef9177e67e7386154a2)]:
  - @moonshot-ai/kosong@0.2.1

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
