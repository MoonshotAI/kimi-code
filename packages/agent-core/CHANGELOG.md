# @moonshot-ai/agent-core

## 0.10.0

### Minor Changes

- [#468](https://github.com/MoonshotAI/kimi-code/pull/468) [`df4f2d6`](https://github.com/MoonshotAI/kimi-code/commit/df4f2d6e8611074cc0b439928f27decba53d2e9a) - Add experimental sub-skill discovery gated by the `KIMI_CODE_EXPERIMENTAL_SUB_SKILL` environment variable. Ships the `sub-skill` builtin bundle (`sub-skill.review`, `sub-skill.consolidate`) for inventorying and consolidating skills into hierarchical groups.

- [#458](https://github.com/MoonshotAI/kimi-code/pull/458) [`93eb70a`](https://github.com/MoonshotAI/kimi-code/commit/93eb70a727c9724e19a31b0d2fbebb78b7390c78) - Migrate still-relevant environment variables from kimi-cli:

  - `KIMI_MODEL_TEMPERATURE`, `KIMI_MODEL_TOP_P` — sampling parameters applied globally to any `kimi` provider (not tied to `KIMI_MODEL_NAME`).
  - `KIMI_MODEL_THINKING_KEEP` — Moonshot preserved-thinking passthrough (`thinking.keep`), injected only while Thinking is on.
  - `KIMI_CODE_NO_AUTO_UPDATE` (legacy alias `KIMI_CLI_NO_AUTO_UPDATE`) — fully disables the update preflight (no check, background install, or prompt).

- [#470](https://github.com/MoonshotAI/kimi-code/pull/470) [`aa610e2`](https://github.com/MoonshotAI/kimi-code/commit/aa610e247deca737101e4de848122db1c8ee9fb3) - Use a fixed 30-minute timeout for subagents and show concise resume instructions when they time out.

### Patch Changes

- [#456](https://github.com/MoonshotAI/kimi-code/pull/456) [`3a98713`](https://github.com/MoonshotAI/kimi-code/commit/3a987130500fe5b403b696850165735c7d0ee076) - Show concise provider filtering errors when responses are blocked before visible output.

- [#464](https://github.com/MoonshotAI/kimi-code/pull/464) [`4f9977d`](https://github.com/MoonshotAI/kimi-code/commit/4f9977d4dcd2df14e6a310396c37af170b2eac50) - Preserve thinking effort when compacting long conversations.

- Updated dependencies [[`3a98713`](https://github.com/MoonshotAI/kimi-code/commit/3a987130500fe5b403b696850165735c7d0ee076), [`93eb70a`](https://github.com/MoonshotAI/kimi-code/commit/93eb70a727c9724e19a31b0d2fbebb78b7390c78)]:
  - @moonshot-ai/kosong@0.3.4

## 0.9.0

### Minor Changes

- [#433](https://github.com/MoonshotAI/kimi-code/pull/433) [`85338e9`](https://github.com/MoonshotAI/kimi-code/commit/85338e9f7df5d98234fd42891e9bf2a2e6ad767b) - Add the built-in `update-config` skill — you can now have Kimi edit its own config files.

- [#420](https://github.com/MoonshotAI/kimi-code/pull/420) [`86a42a2`](https://github.com/MoonshotAI/kimi-code/commit/86a42a26a1e01f1748a937031fa76ebeaa1e28a8) - Add persistent experimental feature toggles and a TUI panel that applies confirmed changes by reloading the current session.

- [#383](https://github.com/MoonshotAI/kimi-code/pull/383) [`15d71b5`](https://github.com/MoonshotAI/kimi-code/commit/15d71b5130d949c35d9dc2641e807e08d72dce48) - Add /reload to reload the current session and apply updated config files, plus /reload-tui to reload only TUI preferences.

### Patch Changes

- [#393](https://github.com/MoonshotAI/kimi-code/pull/393) [`beb12ac`](https://github.com/MoonshotAI/kimi-code/commit/beb12ac0216818a5c5eda24fb304e4ab01792784) - Stop carrying active and queued goals into forked sessions.

- [#387](https://github.com/MoonshotAI/kimi-code/pull/387) [`6e74027`](https://github.com/MoonshotAI/kimi-code/commit/6e74027fdc48ad124b2a62465bb5fd07e84d4712) - Lowercase the stale file content message in edit tool errors.

- [#399](https://github.com/MoonshotAI/kimi-code/pull/399) [`232ed87`](https://github.com/MoonshotAI/kimi-code/commit/232ed874d41de777e6ff9c539ac22d830d0b5c3a) - Keep managed OAuth credentials scoped to their configured authentication and API endpoints.

- [#430](https://github.com/MoonshotAI/kimi-code/pull/430) [`be0da5f`](https://github.com/MoonshotAI/kimi-code/commit/be0da5ff39641e117d60045a43a7d5d2e0b85b75) - Fail early when Git Bash is missing on Windows before starting CLI sessions.

- Updated dependencies [[`4598262`](https://github.com/MoonshotAI/kimi-code/commit/459826292f855592288bcfddaa1c72529a6d8c64)]:
  - @moonshot-ai/kosong@0.3.3

## 0.8.0

### Minor Changes

- [#338](https://github.com/MoonshotAI/kimi-code/pull/338) [`ba7dd73`](https://github.com/MoonshotAI/kimi-code/commit/ba7dd736a3b295b2a29c229a944208c232d51458) - Add `/btw` for side-channel conversations without steering the active main turn.

- [#357](https://github.com/MoonshotAI/kimi-code/pull/357) [`179aecf`](https://github.com/MoonshotAI/kimi-code/commit/179aecf42379e8ef4091f5351c91cd460ba11bdd) - Log enabled experimental flags at startup.

### Patch Changes

- [#365](https://github.com/MoonshotAI/kimi-code/pull/365) [`6a22523`](https://github.com/MoonshotAI/kimi-code/commit/6a2252343a0d624b326b2d369ec908bc8d60092d) - Fix goal budget tool schemas for OpenAI-compatible providers.

- [#380](https://github.com/MoonshotAI/kimi-code/pull/380) [`8639105`](https://github.com/MoonshotAI/kimi-code/commit/86391053139ad4ea437afe79f472412fb1b106a1) - Resume saved subagents lazily when they are accessed.

- [#365](https://github.com/MoonshotAI/kimi-code/pull/365) [`6a22523`](https://github.com/MoonshotAI/kimi-code/commit/6a2252343a0d624b326b2d369ec908bc8d60092d) - Use configured model output limits for completion token caps.

- Updated dependencies [[`6a22523`](https://github.com/MoonshotAI/kimi-code/commit/6a2252343a0d624b326b2d369ec908bc8d60092d)]:
  - @moonshot-ai/kosong@0.3.2

## 0.7.0

### Minor Changes

- [#319](https://github.com/MoonshotAI/kimi-code/pull/319) [`fe7db4a`](https://github.com/MoonshotAI/kimi-code/commit/fe7db4a7e361b83194eb1ebb52d27daed53be532) - Append the current todo list as markdown to compaction summaries before writing them to history.

- [#270](https://github.com/MoonshotAI/kimi-code/pull/270) [`ac37d74`](https://github.com/MoonshotAI/kimi-code/commit/ac37d7448458fdb73fbe00e35856dcf44a13f734) - Add experimental goal mode for longer tasks that need more than one turn. Turn it on with `KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1` before you start Kimi.

  Use `/goal <objective>` in the TUI when you want Kimi to keep working on one task across turns. For example:

  ```text
  /goal Fix the failing checkout test
  ```

  Kimi shows the goal in the TUI and keeps progress visible while it works. Use `/goal status`, `/goal pause`, `/goal resume`, `/goal cancel`, and `/goal replace <objective>` to manage the goal. This feature is still experimental. Try it and tell us what would make it more useful.

- [#315](https://github.com/MoonshotAI/kimi-code/pull/315) [`191059d`](https://github.com/MoonshotAI/kimi-code/commit/191059d40049d3bfd07661ac03bb961eac1407f7) - Add background structured questions so agents can continue while waiting for user answers.

- [#277](https://github.com/MoonshotAI/kimi-code/pull/277) [`a217ff0`](https://github.com/MoonshotAI/kimi-code/commit/a217ff09aad0665b1501b156c2cc1f186b876087) - Add `/undo` slash command to withdraw the last prompt from conversation history, and keep replay records in sync when a prompt is undone.

- [#336](https://github.com/MoonshotAI/kimi-code/pull/336) [`7cda9c3`](https://github.com/MoonshotAI/kimi-code/commit/7cda9c3866bad6b3ce8f95c383a111e1ee5e9325) - Add approval lifecycle hook events for observing pending and completed permission prompts.

### Patch Changes

- [#285](https://github.com/MoonshotAI/kimi-code/pull/285) [`573c56e`](https://github.com/MoonshotAI/kimi-code/commit/573c56e829a10e8a45738a37250d8c15f4ab8d8d) - Consolidate background task management under the agent background runtime.

- [#311](https://github.com/MoonshotAI/kimi-code/pull/311) [`80164c2`](https://github.com/MoonshotAI/kimi-code/commit/80164c2e975ba82f7c915dc3fce6cb00b9d29f6e) - Normalize glob patterns before brace expansion to prevent incorrect path matching.

- [#283](https://github.com/MoonshotAI/kimi-code/pull/283) [`91b292e`](https://github.com/MoonshotAI/kimi-code/commit/91b292e898e9d97b0501cf787919d7f1a90c89d8) - Allow glob searches to target explicit absolute paths outside the workspace.

- [#135](https://github.com/MoonshotAI/kimi-code/pull/135) [`0071b63`](https://github.com/MoonshotAI/kimi-code/commit/0071b63fc83821430472e11db3c6aa613c0bdf7e) - Fix slash-activated skills not being recognized by the model due to missing system reminder wrapper.

- [#330](https://github.com/MoonshotAI/kimi-code/pull/330) [`7a47045`](https://github.com/MoonshotAI/kimi-code/commit/7a47045af2790eba0e68d5406c670ac759b21755) - Allow subagents to use custom tools registered on their parent agent.

- [#333](https://github.com/MoonshotAI/kimi-code/pull/333) [`1178c5c`](https://github.com/MoonshotAI/kimi-code/commit/1178c5cd148d9d5851574afaafb986be1dfe9b63) - Remind the model to refresh TodoList during long-running tasks and strengthen TodoList progress-tracking guidance.

- Updated dependencies [[`8809f3e`](https://github.com/MoonshotAI/kimi-code/commit/8809f3eb114172ac64cefe43bbf9b9257c5245c0)]:
  - @moonshot-ai/kosong@0.3.1

## 0.6.0

### Minor Changes

- [#232](https://github.com/MoonshotAI/kimi-code/pull/232) [`a24bfb1`](https://github.com/MoonshotAI/kimi-code/commit/a24bfb1df38e58120827a1d8ed881724af2e7b23) - Add `KIMI_MODEL_ADAPTIVE_THINKING` (and a matching `adaptive_thinking` model-alias field) to force adaptive thinking (`thinking: { type: 'adaptive' }`) on or off, overriding the Anthropic model-name version inference. This lets custom-named compatible endpoints that back an adaptive-capable model opt in even when the model name does not encode a parseable Claude version.

- [#204](https://github.com/MoonshotAI/kimi-code/pull/204) [`ee69d0a`](https://github.com/MoonshotAI/kimi-code/commit/ee69d0ac29f56bde4957c14767d7ca436697d9cf) - Render scheduled reminders distinctly in the TUI, expose cron fired events to SDK clients, and report cron fire times with local timezone offsets.

### Patch Changes

- [#282](https://github.com/MoonshotAI/kimi-code/pull/282) [`a580cd3`](https://github.com/MoonshotAI/kimi-code/commit/a580cd3a98664e18642e0e856aeaa9b71ba93516) - Fix glob pattern backslash escaping and include match count in truncation messages.

- [#267](https://github.com/MoonshotAI/kimi-code/pull/267) [`e2e1728`](https://github.com/MoonshotAI/kimi-code/commit/e2e17289fca9bcb23f05cd77f7bcb9cba5db0325) - Report truncated compaction summaries clearly and apply valid completion token budgets across supported providers.

- Updated dependencies [[`a24bfb1`](https://github.com/MoonshotAI/kimi-code/commit/a24bfb1df38e58120827a1d8ed881724af2e7b23), [`a580cd3`](https://github.com/MoonshotAI/kimi-code/commit/a580cd3a98664e18642e0e856aeaa9b71ba93516), [`e2e1728`](https://github.com/MoonshotAI/kimi-code/commit/e2e17289fca9bcb23f05cd77f7bcb9cba5db0325)]:
  - @moonshot-ai/kosong@0.3.0
  - @moonshot-ai/kaos@0.1.3

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
