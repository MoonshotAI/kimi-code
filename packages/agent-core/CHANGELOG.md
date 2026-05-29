# @moonshot-ai/agent-core

## 0.5.0

### Minor Changes

- [#212](https://github.com/MoonshotAI/kimi-code/pull/212) [`2bbea75`](https://github.com/MoonshotAI/kimi-code/commit/2bbea75ee4c0b11f12d2921061774426df40479a) - Add a `KIMI_MODEL_*` environment-variable channel that lets you run Kimi Code against a specific model (provider type, base URL, API key, context size, capabilities, and thinking settings) without editing `config.toml`.

- [#205](https://github.com/MoonshotAI/kimi-code/pull/205) [`96bbc47`](https://github.com/MoonshotAI/kimi-code/commit/96bbc471c4aca9526e4dcfe00e6bad2b653bbe66) - Add an experimental feature-flag system: a central registry (`flags/registry.ts`) plus an env-driven resolver. Gate a feature with `flags.enabled('id')`, toggled via `KIMI_CODE_EXPERIMENTAL_<NAME>` or the `KIMI_CODE_EXPERIMENTAL_FLAG` master switch. No flags are defined yet.

- [#221](https://github.com/MoonshotAI/kimi-code/pull/221) [`bab2da7`](https://github.com/MoonshotAI/kimi-code/commit/bab2da7b1c785d6deba25decb1411f8f5a70de8c) - Install plugins directly from GitHub repository URLs, and surface each install's origin and trust level (kimi-official, curated, third-party) in the plugin manager.

- [#118](https://github.com/MoonshotAI/kimi-code/pull/118) [`8913440`](https://github.com/MoonshotAI/kimi-code/commit/891344054111a05171963cfa524ef749c2855321) - Support querying sessions by sessionId or workDir in listSessions, and show a helpful cd command when resuming a session from a different working directory.

- [#186](https://github.com/MoonshotAI/kimi-code/pull/186) [`537cf20`](https://github.com/MoonshotAI/kimi-code/commit/537cf20d18b26d4238f963f793f8a8ef085ac97e) - Remove the default per-turn step limit of 1000. Users can still set `max_steps_per_turn` in config to enforce a custom limit.

### Patch Changes

- [#197](https://github.com/MoonshotAI/kimi-code/pull/197) [`f3269ea`](https://github.com/MoonshotAI/kimi-code/commit/f3269eacb9da9a6b66f578a864d0b9bdfb1d6d81) - Show the real terminal status of background agents in the transcript so lost, failed, and killed ones no longer appear as completed, and include the resume agent id and recovery instructions in the failure notification so the model can resume reliably.

- [#211](https://github.com/MoonshotAI/kimi-code/pull/211) [`54590d3`](https://github.com/MoonshotAI/kimi-code/commit/54590d3d464b05eed0837a725b37f3aa491c09af) - Back off failed compaction retries by a fixed slice of the model context window.

- [#167](https://github.com/MoonshotAI/kimi-code/pull/167) [`b5981a5`](https://github.com/MoonshotAI/kimi-code/commit/b5981a523b66ff2fd5f09a7e66075628b94683c8) - Introduce `ModelProvider` interface and `SingleModelProvider` to decouple `Agent` from `ProviderManager`.

- [#213](https://github.com/MoonshotAI/kimi-code/pull/213) [`2388f20`](https://github.com/MoonshotAI/kimi-code/commit/2388f20bb3d039e89caefca159801059b90dc64a) - Handle context overflow errors consistently across provider responses.

- [#198](https://github.com/MoonshotAI/kimi-code/pull/198) [`8c77cfa`](https://github.com/MoonshotAI/kimi-code/commit/8c77cfab62617e07b38f8514a8ef7cddfd9f1069) - Fix automatic ripgrep installation when temporary files are on another filesystem.

- [#195](https://github.com/MoonshotAI/kimi-code/pull/195) [`3a0e060`](https://github.com/MoonshotAI/kimi-code/commit/3a0e06031ac6dfde148f64906a06cfe820ad9c63) - Project persisted hook and blocked prompt messages into model context.

- [#221](https://github.com/MoonshotAI/kimi-code/pull/221) [`bab2da7`](https://github.com/MoonshotAI/kimi-code/commit/bab2da7b1c785d6deba25decb1411f8f5a70de8c) - Restrict plugin trust badges to Kimi-hosted plugin CDN URL patterns.

- [#207](https://github.com/MoonshotAI/kimi-code/pull/207) [`e280f33`](https://github.com/MoonshotAI/kimi-code/commit/e280f33daf7fbf1271c872dcb224737ec9518f73) - Recover from provider model token limit errors during long conversations.

- [#190](https://github.com/MoonshotAI/kimi-code/pull/190) [`1873859`](https://github.com/MoonshotAI/kimi-code/commit/1873859b0ef093a956dfd19e1530e920e7118160) - Slim the LLM diagnostic logs with fewer, more compact fields.

- [#185](https://github.com/MoonshotAI/kimi-code/pull/185) [`114777e`](https://github.com/MoonshotAI/kimi-code/commit/114777e859680f807375760271533e2dc396af5d) - Split `RuntimeConfig` into `Kaos` and `ToolServices` and update all references accordingly.

- [#189](https://github.com/MoonshotAI/kimi-code/pull/189) [`564721f`](https://github.com/MoonshotAI/kimi-code/commit/564721fe16e582b2774835b01dec799cbb1d0122) - Clarify subagent and background task stop messages as user-initiated.

- [#206](https://github.com/MoonshotAI/kimi-code/pull/206) [`07d51e4`](https://github.com/MoonshotAI/kimi-code/commit/07d51e4add6ee23a56fb8745aa7754f05f3d6d36) - Relocate shared tool service typing to the tool support layer.

- [#200](https://github.com/MoonshotAI/kimi-code/pull/200) [`5159af3`](https://github.com/MoonshotAI/kimi-code/commit/5159af341c7d388a158e41afb470a2281333f329) - Keep blocked prompt hook conversations available to subsequent model turns.

- Updated dependencies [[`2388f20`](https://github.com/MoonshotAI/kimi-code/commit/2388f20bb3d039e89caefca159801059b90dc64a), [`13e0fff`](https://github.com/MoonshotAI/kimi-code/commit/13e0fff462e2ddbec5fb4c9de8ed8e6068db09f1), [`e280f33`](https://github.com/MoonshotAI/kimi-code/commit/e280f33daf7fbf1271c872dcb224737ec9518f73), [`3da4dae`](https://github.com/MoonshotAI/kimi-code/commit/3da4daeadee39573c7eeede30fa9465b411be3e2)]:
  - @moonshot-ai/kosong@0.2.3

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
