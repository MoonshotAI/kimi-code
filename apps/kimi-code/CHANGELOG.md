# @moonshot-ai/kimi-code

## 0.6.0

### Minor Changes

- [#212](https://github.com/MoonshotAI/kimi-code/pull/212) [`2bbea75`](https://github.com/MoonshotAI/kimi-code/commit/2bbea75ee4c0b11f12d2921061774426df40479a) - Add a `KIMI_MODEL_*` environment-variable channel that lets you run Kimi Code against a specific model (provider type, base URL, API key, context size, capabilities, and thinking settings) without editing `config.toml`.

- [#221](https://github.com/MoonshotAI/kimi-code/pull/221) [`bab2da7`](https://github.com/MoonshotAI/kimi-code/commit/bab2da7b1c785d6deba25decb1411f8f5a70de8c) - Install plugins directly from GitHub repository URLs, and surface each install's origin and trust level (kimi-official, curated, third-party) in the plugin manager.

- [#118](https://github.com/MoonshotAI/kimi-code/pull/118) [`8913440`](https://github.com/MoonshotAI/kimi-code/commit/891344054111a05171963cfa524ef749c2855321) - Support querying sessions by sessionId or workDir in listSessions, and show a helpful cd command when resuming a session from a different working directory.

- [#186](https://github.com/MoonshotAI/kimi-code/pull/186) [`537cf20`](https://github.com/MoonshotAI/kimi-code/commit/537cf20d18b26d4238f963f793f8a8ef085ac97e) - Remove the default per-turn step limit of 1000. Users can still set `max_steps_per_turn` in config to enforce a custom limit.

### Patch Changes

- [#197](https://github.com/MoonshotAI/kimi-code/pull/197) [`f3269ea`](https://github.com/MoonshotAI/kimi-code/commit/f3269eacb9da9a6b66f578a864d0b9bdfb1d6d81) - Show the real terminal status of background agents in the transcript so lost, failed, and killed ones no longer appear as completed, and include the resume agent id and recovery instructions in the failure notification so the model can resume reliably.

- [#211](https://github.com/MoonshotAI/kimi-code/pull/211) [`54590d3`](https://github.com/MoonshotAI/kimi-code/commit/54590d3d464b05eed0837a725b37f3aa491c09af) - Back off failed compaction retries by a fixed slice of the model context window.

- [#167](https://github.com/MoonshotAI/kimi-code/pull/167) [`b5981a5`](https://github.com/MoonshotAI/kimi-code/commit/b5981a523b66ff2fd5f09a7e66075628b94683c8) - Introduce `ModelProvider` interface and `SingleModelProvider` to decouple `Agent` from `ProviderManager`.

- [#213](https://github.com/MoonshotAI/kimi-code/pull/213) [`2388f20`](https://github.com/MoonshotAI/kimi-code/commit/2388f20bb3d039e89caefca159801059b90dc64a) - Handle context overflow errors consistently across provider responses.

- [#214](https://github.com/MoonshotAI/kimi-code/pull/214) [`caaa6d8`](https://github.com/MoonshotAI/kimi-code/commit/caaa6d83ee262ba4c954386458ee13aacdb26e1a) - Fix the native self-updater reporting a successful update when the install command actually failed.

- [#202](https://github.com/MoonshotAI/kimi-code/pull/202) [`14a0348`](https://github.com/MoonshotAI/kimi-code/commit/14a03488555682dde4bcd74aadf79f60a9827304) - Fix footer leaking onto the terminal when resuming a non-existent session.

- [#198](https://github.com/MoonshotAI/kimi-code/pull/198) [`8c77cfa`](https://github.com/MoonshotAI/kimi-code/commit/8c77cfab62617e07b38f8514a8ef7cddfd9f1069) - Fix automatic ripgrep installation when temporary files are on another filesystem.

- [#199](https://github.com/MoonshotAI/kimi-code/pull/199) [`588145d`](https://github.com/MoonshotAI/kimi-code/commit/588145dc9b266456bdb1d739975a5b9cf33d70ae) - Expand the footer's rotating tips to surface more commands and shortcuts, featuring newer and important ones more prominently.

- [#192](https://github.com/MoonshotAI/kimi-code/pull/192) [`64964a0`](https://github.com/MoonshotAI/kimi-code/commit/64964a0dda98fc2db5e15ba923ea9414c78e0009) - Improve the usage information display in the TUI.

- [#195](https://github.com/MoonshotAI/kimi-code/pull/195) [`3a0e060`](https://github.com/MoonshotAI/kimi-code/commit/3a0e06031ac6dfde148f64906a06cfe820ad9c63) - Project persisted hook and blocked prompt messages into model context.

- [#221](https://github.com/MoonshotAI/kimi-code/pull/221) [`bab2da7`](https://github.com/MoonshotAI/kimi-code/commit/bab2da7b1c785d6deba25decb1411f8f5a70de8c) - Restrict plugin trust badges to Kimi-hosted plugin CDN URL patterns.

- [#207](https://github.com/MoonshotAI/kimi-code/pull/207) [`e280f33`](https://github.com/MoonshotAI/kimi-code/commit/e280f33daf7fbf1271c872dcb224737ec9518f73) - Recover from provider model token limit errors during long conversations.

- [#201](https://github.com/MoonshotAI/kimi-code/pull/201) [`3da4dae`](https://github.com/MoonshotAI/kimi-code/commit/3da4daeadee39573c7eeede30fa9465b411be3e2) - Automatically retry when a model response stream is dropped mid-flight (a `terminated` error) instead of failing the turn.

- [#190](https://github.com/MoonshotAI/kimi-code/pull/190) [`1873859`](https://github.com/MoonshotAI/kimi-code/commit/1873859b0ef093a956dfd19e1530e920e7118160) - Slim the LLM diagnostic logs with fewer, more compact fields.

- [#185](https://github.com/MoonshotAI/kimi-code/pull/185) [`114777e`](https://github.com/MoonshotAI/kimi-code/commit/114777e859680f807375760271533e2dc396af5d) - Split `RuntimeConfig` into `Kaos` and `ToolServices` and update all references accordingly.

- [#189](https://github.com/MoonshotAI/kimi-code/pull/189) [`564721f`](https://github.com/MoonshotAI/kimi-code/commit/564721fe16e582b2774835b01dec799cbb1d0122) - Clarify subagent and background task stop messages as user-initiated.

- [#206](https://github.com/MoonshotAI/kimi-code/pull/206) [`07d51e4`](https://github.com/MoonshotAI/kimi-code/commit/07d51e4add6ee23a56fb8745aa7754f05f3d6d36) - Relocate shared tool service typing to the tool support layer.

- [#215](https://github.com/MoonshotAI/kimi-code/pull/215) [`b9860e9`](https://github.com/MoonshotAI/kimi-code/commit/b9860e9f6ec65eb5dfdabbad54f1a87d69f4f00a) - Align the datasource plugin with the generic two-tool workflow.

- [#200](https://github.com/MoonshotAI/kimi-code/pull/200) [`5159af3`](https://github.com/MoonshotAI/kimi-code/commit/5159af341c7d388a158e41afb470a2281333f329) - Keep blocked prompt hook conversations available to subsequent model turns.

## 0.5.0

### Minor Changes

- [#163](https://github.com/MoonshotAI/kimi-code/pull/163) [`07dd604`](https://github.com/MoonshotAI/kimi-code/commit/07dd604c3c7f453dfb0c0a601bb1c44a8114bb3b) - Add `/auto` slash command and `--auto` CLI flag for auto permission mode.

- [#157](https://github.com/MoonshotAI/kimi-code/pull/157) [`971fce6`](https://github.com/MoonshotAI/kimi-code/commit/971fce6e528c2b210df1852d7cd12bcda71014fd) - Add scheduled tasks:

  You can now ask the agent to remind you at a specific time, run a task on a recurring cron schedule (for example, check a deploy every 5 minutes or run a daily report every weekday at 9am), or come back on its own in a few minutes to continue what it was doing.

  Schedules use the standard 5-field cron syntax.

### Patch Changes

- [#162](https://github.com/MoonshotAI/kimi-code/pull/162) [`f3c1015`](https://github.com/MoonshotAI/kimi-code/commit/f3c1015b677d40fb94957ab121da5e14480a890f) - Add a clickable changelog link to the update prompt.

- [#150](https://github.com/MoonshotAI/kimi-code/pull/150) [`8b5a251`](https://github.com/MoonshotAI/kimi-code/commit/8b5a25161ceac02894d1a09c78a5aa883e460c8e) - Show the full Bash command when expanding a Bash tool card with `ctrl+o`. The header still truncates long commands at 60 chars, but the expanded view now reveals the complete multi-line command above the output.

- [#158](https://github.com/MoonshotAI/kimi-code/pull/158) [`d1f9a83`](https://github.com/MoonshotAI/kimi-code/commit/d1f9a83d7af16ab78b7da571b3de146767864f3a) - Shorten the session title written to the terminal window/tab from 80 to 32 characters so long first messages and pasted content no longer stretch the tab bar past readable width.

- [#146](https://github.com/MoonshotAI/kimi-code/pull/146) [`76cbf86`](https://github.com/MoonshotAI/kimi-code/commit/76cbf86e2035f905242d30009052254eee52bcf8) - Cap the inline todo panel at five rows and show a `+N more` indicator so long task lists no longer fill the screen.

- [#120](https://github.com/MoonshotAI/kimi-code/pull/120) [`8515472`](https://github.com/MoonshotAI/kimi-code/commit/85154724764a3478bfc0ef40d8b5a1def5063ec7) - Fix compaction to handle edge cases where no messages are compactable and improve retry logic.

- [#159](https://github.com/MoonshotAI/kimi-code/pull/159) [`c88b7bf`](https://github.com/MoonshotAI/kimi-code/commit/c88b7bf0efcf6f0e5f904c20471ab865cb912e40) - Fix official datasource tools to preserve complete responses and write returned result files.

- [#124](https://github.com/MoonshotAI/kimi-code/pull/124) [`3e72f25`](https://github.com/MoonshotAI/kimi-code/commit/3e72f25ad93dac02456ebb1e29d80cf904258c14) - Fix migration mapping the legacy `default_yolo` key to the dead `yolo` field instead of `default_permission_mode`.

- [#164](https://github.com/MoonshotAI/kimi-code/pull/164) [`0a76658`](https://github.com/MoonshotAI/kimi-code/commit/0a766584cba68b2e906a5528c286a8481bd47ed3) - Clarify plugin manager keyboard shortcuts and show plugin state changes inline.

- [#142](https://github.com/MoonshotAI/kimi-code/pull/142) [`dad2b87`](https://github.com/MoonshotAI/kimi-code/commit/dad2b87ceeb054204027709751f72baadf04b708) - Refactor TUI code structure.

- [#166](https://github.com/MoonshotAI/kimi-code/pull/166) [`92e1d8c`](https://github.com/MoonshotAI/kimi-code/commit/92e1d8c72bfb1ab31a46608120670698bbf582b8) - Report discovered plugin skills in plugin manager summaries.

- [#139](https://github.com/MoonshotAI/kimi-code/pull/139) [`50251a1`](https://github.com/MoonshotAI/kimi-code/commit/50251a136093c27c0d69a730b267b746dea47468) - Show file content and diff in Write and Edit approval prompts, and open them in a dedicated full-screen viewer on ctrl+e instead of expanding inline.

- [#117](https://github.com/MoonshotAI/kimi-code/pull/117) [`a6d379b`](https://github.com/MoonshotAI/kimi-code/commit/a6d379b2ceea4bf988517bdf357d1931a1fb1f05) - Offload large base64 media payloads from wire.jsonl into external blob files to reduce wire size and memory pressure during session replay. Includes an in-memory read-through cache on `BlobStore` so repeated rehydration avoids redundant disk reads.

- [#150](https://github.com/MoonshotAI/kimi-code/pull/150) [`8b5a251`](https://github.com/MoonshotAI/kimi-code/commit/8b5a25161ceac02894d1a09c78a5aa883e460c8e) - Wrap long question, body, and option text in the AskUserQuestion dialog instead of truncating with an ellipsis. The question prompt, body description, option label, option description, and submit-tab review entries now flow onto multiple lines with a hanging indent.

## 0.4.0

### Minor Changes

- [#116](https://github.com/MoonshotAI/kimi-code/pull/116) [`2c7a8cc`](https://github.com/MoonshotAI/kimi-code/commit/2c7a8cc010a7b8134c5f16185e031a6de4585165) - Expand folded paste markers on second paste. When the cursor is on a paste marker (e.g. `[paste [#1](https://github.com/MoonshotAI/kimi-code/issues/1) +15 lines]`) and the user pastes again, the marker expands back to the original content instead of inserting new clipboard data.

- [#26](https://github.com/MoonshotAI/kimi-code/pull/26) [`2b74025`](https://github.com/MoonshotAI/kimi-code/commit/2b74025302be9b42e68a15f33333c55d64a6c9e7) - Rework tool permissions: reads outside cwd no longer prompt, session approvals match the exact call, and path-based rules are case-insensitive.

- [#119](https://github.com/MoonshotAI/kimi-code/pull/119) [`ebf6e81`](https://github.com/MoonshotAI/kimi-code/commit/ebf6e8181ea20a0fcf6a609195ccf5b6cc2a665a) - Add user-global plugin installation, interactive plugin management, plugin-provided skills, and plugin-owned MCP servers.

- [#112](https://github.com/MoonshotAI/kimi-code/pull/112) [`d03f6f4`](https://github.com/MoonshotAI/kimi-code/commit/d03f6f4fa582314a4330d0049fed6a0baae7271a) - Add `/export-debug-zip` slash command to export the current session as a debug ZIP archive directly from the TUI.

- [#113](https://github.com/MoonshotAI/kimi-code/pull/113) [`028d069`](https://github.com/MoonshotAI/kimi-code/commit/028d069b12d8377c5c307b94f11f02233d9c0a26) - Add `/export-md` slash command to export the current session as a Markdown file.

### Patch Changes

- [#105](https://github.com/MoonshotAI/kimi-code/pull/105) [`d599183`](https://github.com/MoonshotAI/kimi-code/commit/d599183c8eccea813d7aa5ddd974e72139cbb63c) - Enhance `kimi export` to include more diagnostic information in the manifest.

- [#89](https://github.com/MoonshotAI/kimi-code/pull/89) [`61cae59`](https://github.com/MoonshotAI/kimi-code/commit/61cae592fac0f1d824ee28263375937452f719ff) - Prevent the TUI from crashing when pull request lookup fails during startup.

- [#97](https://github.com/MoonshotAI/kimi-code/pull/97) [`2e8c417`](https://github.com/MoonshotAI/kimi-code/commit/2e8c417818bb68a71789e4966f18c2be6d39d835) - Fix thinking spinner leaking past turn end when an empty thinking delta creates an orphaned thinking component.

- [#103](https://github.com/MoonshotAI/kimi-code/pull/103) [`73c4232`](https://github.com/MoonshotAI/kimi-code/commit/73c4232e711c8e7c701d21a07c7b6aace3476360) - Show the original session resume command after forking a session.

- [#88](https://github.com/MoonshotAI/kimi-code/pull/88) [`ce420bf`](https://github.com/MoonshotAI/kimi-code/commit/ce420bf1c6825080d4c7ec9e155f96039d3376e7) - Refactor TUI resume replay logic.

- [#119](https://github.com/MoonshotAI/kimi-code/pull/119) [`ebf6e81`](https://github.com/MoonshotAI/kimi-code/commit/ebf6e8181ea20a0fcf6a609195ccf5b6cc2a665a) - Restrict plugin zip installs to manifests at the archive root or a single wrapper directory.

- [#102](https://github.com/MoonshotAI/kimi-code/pull/102) [`6f55f1d`](https://github.com/MoonshotAI/kimi-code/commit/6f55f1d0aff12ce13cea616a1f37e6242beb2ff8) - Route session-tagged log entries exclusively to the session sink instead of duplicating them to the global sink. Consistently omit stable main-agent context keys from all session log lines that carry `agentId=main`.

- [#92](https://github.com/MoonshotAI/kimi-code/pull/92) [`4e458d6`](https://github.com/MoonshotAI/kimi-code/commit/4e458d63643a56a2fb1ba9f908c774e56eef1c75) - Use one retry classification for transient LLM failures across regular turns and compaction.

## 0.3.0

### Minor Changes

- [#76](https://github.com/MoonshotAI/kimi-code/pull/76) [`6f22ae4`](https://github.com/MoonshotAI/kimi-code/commit/6f22ae48f84a062a65dcaa9510ffe96f40ab503b) - /logout now opens a picker so you can choose which provider to log out of, instead of always logging out the one tied to the current model. The current provider is highlighted by default, so pressing Enter matches the previous behavior. The command is also available as /disconnect.

### Patch Changes

- [#62](https://github.com/MoonshotAI/kimi-code/pull/62) [`e2b2b46`](https://github.com/MoonshotAI/kimi-code/commit/e2b2b46fc9c1d6a0ada67c590b8aa56e77c9c513) - Make `AgentRecords` hold the `Agent` instance directly and inline the restore dispatch logic.

- [#73](https://github.com/MoonshotAI/kimi-code/pull/73) [`bddc60f`](https://github.com/MoonshotAI/kimi-code/commit/bddc60f0e9af44d326dc0759a60bce93187f8a7b) - Prevent running the `/model` and `/sessions` slash commands while streaming or compacting context.

- [#70](https://github.com/MoonshotAI/kimi-code/pull/70) [`d95b013`](https://github.com/MoonshotAI/kimi-code/commit/d95b01342a7921f0863ceb37abad7984d0245509) - Preserve catalog-declared interleaved reasoning fields for OpenAI-compatible models configured through `/connect`.

- [#78](https://github.com/MoonshotAI/kimi-code/pull/78) [`61f7d0e`](https://github.com/MoonshotAI/kimi-code/commit/61f7d0e7a2b9933bdbe7eef9177e67e7386154a2) - Make OpenAI-compatible reasoner models work out of the box for hand-written provider configs. The `openai` provider now auto-detects thinking on incoming responses by scanning the de facto field set (`reasoning_content`, `reasoning_details`, `reasoning`), serializes thinking back as `reasoning_content` by default, and auto-injects `reasoning_effort` whenever the conversation history contains prior thinking — so DeepSeek, Qwen, One API and other gateway-fronted services no longer require a hand-set `reasoning_key`. The `reasoning_key` model-alias field remains available as an explicit override for non-standard gateways.

- [#66](https://github.com/MoonshotAI/kimi-code/pull/66) [`8ddfc04`](https://github.com/MoonshotAI/kimi-code/commit/8ddfc0433e3a3a51f326116607d28b0f409e7d93) - Fix API key input dialog showing a masked dot in empty state.

- [#72](https://github.com/MoonshotAI/kimi-code/pull/72) [`0ce0072`](https://github.com/MoonshotAI/kimi-code/commit/0ce0072cb44ea2bd3a7ca9c54d141c150f0bbb77) - Fix user skills in ~/.agents/ not being loaded.

- [#86](https://github.com/MoonshotAI/kimi-code/pull/86) [`5e354d0`](https://github.com/MoonshotAI/kimi-code/commit/5e354d0cc89816228d08c3ded17e75201fb300de) - Restore real-time token display for running subagents in the TUI.

- [#57](https://github.com/MoonshotAI/kimi-code/pull/57) [`8fb61f9`](https://github.com/MoonshotAI/kimi-code/commit/8fb61f9a3ead02bbd79f3a5ab605aba26e1cb847) - Hide the todo panel on resume when all todos are already completed.

- [#83](https://github.com/MoonshotAI/kimi-code/pull/83) [`7d9216d`](https://github.com/MoonshotAI/kimi-code/commit/7d9216d5aa1e96734c46c8d5d810ec7ed27b2275) - Always emit a paired tool result when a tool returns a malformed or missing result, preventing the next request from failing with a missing tool_call_id error.

- [#81](https://github.com/MoonshotAI/kimi-code/pull/81) [`1fbefc9`](https://github.com/MoonshotAI/kimi-code/commit/1fbefc99398d4a8ebebb377ff7ca2846483d1a9a) - Improve the Write tool UX.

- [#79](https://github.com/MoonshotAI/kimi-code/pull/79) [`5a90b53`](https://github.com/MoonshotAI/kimi-code/commit/5a90b53b045099ecb582a36d546e90a3978f0a75) - Fix Plan mode session resets so new sessions no longer fail after plan review rejection and continue receiving events after setup errors.

- [#77](https://github.com/MoonshotAI/kimi-code/pull/77) [`fe60c21`](https://github.com/MoonshotAI/kimi-code/commit/fe60c215be8979f6abc8258e5255c66dd73d5a19) - Exit promptly when the controlling terminal goes away. The TUI now handles `SIGHUP` / `SIGTERM` and stdout/stderr `EIO` / `EPIPE` / `ENOTCONN` errors, preventing leftover `kimi` processes that pin a CPU core after the parent shell or multiplexer dies unexpectedly.

- [#85](https://github.com/MoonshotAI/kimi-code/pull/85) [`2bb50a3`](https://github.com/MoonshotAI/kimi-code/commit/2bb50a38d8379e2fac57547b1a563722f713c8fd) - Avoid overly small local completion caps that can truncate reasoning before summaries are produced.

## 0.2.0

### Minor Changes

- [#30](https://github.com/MoonshotAI/kimi-code/pull/30) [`a200a29`](https://github.com/MoonshotAI/kimi-code/commit/a200a297ac8986ec4baa8d2cdc881ef71bc3abfc) - Add a `/connect` command that configures a provider and model from a model catalog.

- [#30](https://github.com/MoonshotAI/kimi-code/pull/30) [`a200a29`](https://github.com/MoonshotAI/kimi-code/commit/a200a297ac8986ec4baa8d2cdc881ef71bc3abfc) - The `/connect` provider and model pickers now support type-to-search filtering, and long lists are paginated. The `/model` picker is also paginated when many models are configured.

- [#25](https://github.com/MoonshotAI/kimi-code/pull/25) [`c4dd1c7`](https://github.com/MoonshotAI/kimi-code/commit/c4dd1c7ff298290ee17d4a6676f93284621f32e8) - Flatten tool call data by inlining tool names and arguments at the top level, and limit legacy record migration so it only rewrites matching tool call payloads.

### Patch Changes

- [#9](https://github.com/MoonshotAI/kimi-code/pull/9) [`e503e69`](https://github.com/MoonshotAI/kimi-code/commit/e503e6963ab6cc6b4ed98c89389dbbb525fc6e9e) - Add `Ctrl-J` as an additional shortcut for inserting new lines in the TUI prompt.

- [#22](https://github.com/MoonshotAI/kimi-code/pull/22) [`2004aed`](https://github.com/MoonshotAI/kimi-code/commit/2004aedfe1d4e5e17762108bf48b7b9aa6d4e25b) - Add wire record migration handling during session replay.

- [#33](https://github.com/MoonshotAI/kimi-code/pull/33) [`ab4bd09`](https://github.com/MoonshotAI/kimi-code/commit/ab4bd090825cffbd7ab656b47840b0060d6cf601) - Report the macOS product version in OAuth device information instead of the Darwin kernel version.

- [#52](https://github.com/MoonshotAI/kimi-code/pull/52) [`064343a`](https://github.com/MoonshotAI/kimi-code/commit/064343a6e565a525fbf38b3a1f70f7ff0235a5ed) - Correct the `X-Msh-Platform` header value to `kimi_code_cli`.

- [#38](https://github.com/MoonshotAI/kimi-code/pull/38) [`e9e4a48`](https://github.com/MoonshotAI/kimi-code/commit/e9e4a48633f2d216672e8905b0235107b5cbe34a) - Clarify the prompt-mode error when no model is configured by pointing users to the login flow.

- [#13](https://github.com/MoonshotAI/kimi-code/pull/13) [`35726d7`](https://github.com/MoonshotAI/kimi-code/commit/35726d7a41d54a0e6cb19a21d16980fd462132e1) - Hide the empty current session from the sessions picker while keeping other empty sessions visible.

- [#31](https://github.com/MoonshotAI/kimi-code/pull/31) [`475ebad`](https://github.com/MoonshotAI/kimi-code/commit/475ebadc2070e3b878789f6a89ce191b1bd957a9) - Stop mentioning OAuth credentials in the migration UI — they are never migrated, so the previous "needs /login" notice misread as a failure. OAuth-only installs no longer trigger the migration screen.

- [#31](https://github.com/MoonshotAI/kimi-code/pull/31) [`475ebad`](https://github.com/MoonshotAI/kimi-code/commit/475ebadc2070e3b878789f6a89ce191b1bd957a9) - Migrate user skills from `~/.kimi/skills/` to `~/.kimi-code/skills/` during the first-launch migration; existing target skills are kept.

- [#30](https://github.com/MoonshotAI/kimi-code/pull/30) [`a200a29`](https://github.com/MoonshotAI/kimi-code/commit/a200a297ac8986ec4baa8d2cdc881ef71bc3abfc) - When no models are configured, `/model` and the welcome panel now point users to `/login` (for Kimi) and `/connect` (for other providers).

- [#11](https://github.com/MoonshotAI/kimi-code/pull/11) [`15b018f`](https://github.com/MoonshotAI/kimi-code/commit/15b018fc84a36a9ebde598970e5b44bebe5d68c6) - Surface API-provided error messages during feedback, usage, login, and model setup failures.

- [#24](https://github.com/MoonshotAI/kimi-code/pull/24) [`7858821`](https://github.com/MoonshotAI/kimi-code/commit/7858821f2f1fecc9de666780fc62434ca76dcc82) - Persist model selections from the terminal UI to the default configuration, and honor the configured default thinking state for new sessions.

- [#14](https://github.com/MoonshotAI/kimi-code/pull/14) [`0da6073`](https://github.com/MoonshotAI/kimi-code/commit/0da60730b9716c39a07e8a3a0a320e3af7ad30fa) - Move wire metadata handling into the record layer and keep persistence backends limited to storage operations.

- [#12](https://github.com/MoonshotAI/kimi-code/pull/12) [`89ea895`](https://github.com/MoonshotAI/kimi-code/commit/89ea8959eb9419d04e63645b4d89ca0e33f20d98) - Retry compaction responses that do not contain a summary before updating conversation history.

- [#29](https://github.com/MoonshotAI/kimi-code/pull/29) [`df7a9ca`](https://github.com/MoonshotAI/kimi-code/commit/df7a9cab606e0f152bc45b1d1645d76210b1e0c4) - Avoid CPU spikes from large streamed tool arguments and coalesce high-frequency streaming UI updates.

- [#47](https://github.com/MoonshotAI/kimi-code/pull/47) [`07ed2cf`](https://github.com/MoonshotAI/kimi-code/commit/07ed2cf9d4f01985c00c004b3bc0cc8d2587044b) - Emit session resume hint as a structured meta message in stream-json output format.

- [#49](https://github.com/MoonshotAI/kimi-code/pull/49) [`cf2227e`](https://github.com/MoonshotAI/kimi-code/commit/cf2227e8a5222ad9bd1167b573b62599d0efd906) - Resume sessions with a newer wire protocol version instead of failing. A warning is now shown in the TUI and records are replayed without migration.

- [#18](https://github.com/MoonshotAI/kimi-code/pull/18) [`a964bd2`](https://github.com/MoonshotAI/kimi-code/commit/a964bd2430a583ff0364fde19eafabda03b489ed) - Warn tmux users when extended key settings may prevent modified Enter shortcuts from working.

- [#17](https://github.com/MoonshotAI/kimi-code/pull/17) [`bfbd522`](https://github.com/MoonshotAI/kimi-code/commit/bfbd522a7160e597d673550f09fd4af089bfde34) - Let Kimi requests use the remaining context window for completion tokens by default while keeping explicit environment limits as hard caps.
