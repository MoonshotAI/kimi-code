# @moonshot-ai/agent-core-v2

## 0.7.0

### Minor Changes

- [#5352](https://github.com/MoonshotAI/kimi-code/pull/5352) [`2b1b095`](https://github.com/MoonshotAI/kimi-code/commit/2b1b095f3bbf48e83632b0aaaabce6773caf4469) Thanks [@sailist](https://github.com/sailist)! - Add the `defaultSwarmMode` config section: when `default_swarm_mode = true`, new sessions enter swarm mode on creation.

- [#5352](https://github.com/MoonshotAI/kimi-code/pull/5352) [`2b1b095`](https://github.com/MoonshotAI/kimi-code/commit/2b1b095f3bbf48e83632b0aaaabce6773caf4469) Thanks [@sailist](https://github.com/sailist)! - Remove the swarm mode enter reminder: turning swarm mode on no longer injects guidance into the conversation, and the `swarmReminderDelivered` replayable state is gone.

### Patch Changes

- [#5239](https://github.com/MoonshotAI/kimi-code/pull/5239) [`b53e7a8`](https://github.com/MoonshotAI/kimi-code/commit/b53e7a8b5bb0a485ec4a67e65f0ce92d1fa919f2) Thanks [@sailist](https://github.com/sailist)! - Truncate the model-visible foreground output in the Bash tool's background-detach acknowledgement to the standard tool-result cap; the full output remains available through the task output log and TaskOutput.

- [#5253](https://github.com/MoonshotAI/kimi-code/pull/5253) [`c0e9faf`](https://github.com/MoonshotAI/kimi-code/commit/c0e9faf0bda52462e034d938f41a3aa48a2e6426) Thanks [@7Sageer](https://github.com/7Sageer)! - Automatically approve statically verified read-only Bash commands in Always Ask mode. Add an `ask` permission rule to keep confirming them.

- [#5132](https://github.com/MoonshotAI/kimi-code/pull/5132) [`dbcf39b`](https://github.com/MoonshotAI/kimi-code/commit/dbcf39bddd1d3b68a76782fb3937d8ae3d735b84) Thanks [@sailist](https://github.com/sailist)! - Migrate the existing JSONL storage layer into the core package without changing persistence behavior.

- [#5240](https://github.com/MoonshotAI/kimi-code/pull/5240) [`6bdb7ea`](https://github.com/MoonshotAI/kimi-code/commit/6bdb7ead8cb5c5b5982ebd59c912ae36010bdfa3) Thanks [@sailist](https://github.com/sailist)! - Wait for initial MCP discovery to settle before pinning the agent loop's tool baseline, so tools from slow-starting MCP servers stay visible for the whole session. Loop start is now the single point that waits for MCP readiness; the per-step and per-tool-call waits are removed.

- [#5047](https://github.com/MoonshotAI/kimi-code/pull/5047) [`f9ee8bb`](https://github.com/MoonshotAI/kimi-code/commit/f9ee8bbf4dee5b12bb7ba66e5824dc5386e30c3b) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Add `POST /api/v1/sessions/{session_id}/agents/{agent_id}:close` (advertised via `meta.capabilities.agent_close`) backed by `ISessionBtwService.close`, `IAgentLifecycleService.removeById`, and `ISessionMetadata.unregisterAgent` to abort and remove side-channel (`btw`) agents.

- [#5302](https://github.com/MoonshotAI/kimi-code/pull/5302) [`9f04403`](https://github.com/MoonshotAI/kimi-code/commit/9f0440376150f9f2a94419c1ad8984991f7099db) Thanks [@sailist](https://github.com/sailist)! - Support unloading removed tool declarations for the Kimi provider.

- [#5369](https://github.com/MoonshotAI/kimi-code/pull/5369) [`f8375e1`](https://github.com/MoonshotAI/kimi-code/commit/f8375e18b74130ed82b7a314d10916e942c9f73b) Thanks [@markankamaransheogarat-sys](https://github.com/markankamaransheogarat-sys)! - Delay loop initialization until the first operation for new agents and restore persisted agents immediately.

- [#5203](https://github.com/MoonshotAI/kimi-code/pull/5203) [`3d7f4c1`](https://github.com/MoonshotAI/kimi-code/commit/3d7f4c10e7967ebac6832b9cf17ebb3024d477f5) Thanks [@Grapedge](https://github.com/Grapedge)! - Start a project's MCP servers only while a session or an MCP listing uses them, and never after their session or project has closed.

- [#5261](https://github.com/MoonshotAI/kimi-code/pull/5261) [`9dadda1`](https://github.com/MoonshotAI/kimi-code/commit/9dadda17606cf2c44b5e9e6f0b2d2425edd4be4d) Thanks [@7Sageer](https://github.com/7Sageer)! - Label user media from session metadata at request time, preserve per-attachment labels on provider retries, and save media referenced by direct steering messages.

- [#5301](https://github.com/MoonshotAI/kimi-code/pull/5301) [`afa8ef6`](https://github.com/MoonshotAI/kimi-code/commit/afa8ef65ee0f24092c243dca671d17b62ffae0b2) Thanks [@sailist](https://github.com/sailist)! - Recover conversations when an uploaded image or video can no longer be read: after a matching provider 400, the failed upload is confirmed via the file status endpoint, permanently marked to skip re-upload, and resent inline from the local original.

- [#5295](https://github.com/MoonshotAI/kimi-code/pull/5295) [`92ea0c6`](https://github.com/MoonshotAI/kimi-code/commit/92ea0c6dc3bf718c5a237e28db2d7e2c83978419) Thanks [@sailist](https://github.com/sailist)! - Fix approved plan reviews being reported as rejected tool calls: an approved plan now exits plan mode through normal tool execution and returns the approved plan as a successful result, instead of an error-marked rejection.

- [#5295](https://github.com/MoonshotAI/kimi-code/pull/5295) [`92ea0c6`](https://github.com/MoonshotAI/kimi-code/commit/92ea0c6dc3bf718c5a237e28db2d7e2c83978419) Thanks [@sailist](https://github.com/sailist)! - Run the plan-mode tool guard on the native tool-executor hook chain: plan approvals are awaited inline in the starting hook instead of being deferred through the legacy two-phase event emitter.

- [#5289](https://github.com/MoonshotAI/kimi-code/pull/5289) [`e42d4a5`](https://github.com/MoonshotAI/kimi-code/commit/e42d4a53b8b1fe73bbe5fde3ca142bfe4af3a5cf) Thanks [@7Sageer](https://github.com/7Sageer)! - Automatically reclaim session locks recorded under a different hostname. Shared state directories no longer protect live holders across machines or containers.

- [#5266](https://github.com/MoonshotAI/kimi-code/pull/5266) [`1655099`](https://github.com/MoonshotAI/kimi-code/commit/16550990aa7ae3b526abcb2fb045868bebf5c418) Thanks [@sailist](https://github.com/sailist)! - Record measured tool durations in tool message attributes, so turn, compaction, and resumed requests carry the same tool result timing.

- [#5254](https://github.com/MoonshotAI/kimi-code/pull/5254) [`314a6bd`](https://github.com/MoonshotAI/kimi-code/commit/314a6bd96baa697b41bc4b26dbcc74419af7ebde) Thanks [@7Sageer](https://github.com/7Sageer)! - Remove the experimental context-forking branch from `Agent` and `AgentSwarm` subagent spawning, including its flag, schema parameter, compatibility checks, and telemetry field.

- [#5268](https://github.com/MoonshotAI/kimi-code/pull/5268) [`3a43c68`](https://github.com/MoonshotAI/kimi-code/commit/3a43c683de31440e496b9b926a03db93c2baa16f) Thanks [@sailist](https://github.com/sailist)! - Preserve the raw tool call argument bytes in recorded loop events so resumed sessions rebuild assistant messages identical to the live ones, including malformed or empty arguments.

- [#5058](https://github.com/MoonshotAI/kimi-code/pull/5058) [`638fd94`](https://github.com/MoonshotAI/kimi-code/commit/638fd94b6c22589253570b9b90dbe5359849ddc2) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Add `GET /api/v1/sessions/{session_id}/context/summary`, `/context/items`, and `/context/items/{item_id}`, which return an unresolved read-only snapshot of the agent's system prompt, baseline tool definitions, and raw messages for context inspection and token estimation.

- [#5290](https://github.com/MoonshotAI/kimi-code/pull/5290) [`13b09d9`](https://github.com/MoonshotAI/kimi-code/commit/13b09d994985d7747572730400be6ef89e722ab6) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Mark the session metadata `cwd` field as deprecated in generated schemas, and drop the legacy session wire-field type that no longer has callers.

- [#5190](https://github.com/MoonshotAI/kimi-code/pull/5190) [`1ef139e`](https://github.com/MoonshotAI/kimi-code/commit/1ef139e6c32a01c7ac51a89fea6ae279c91bc276) Thanks [@7Sageer](https://github.com/7Sageer)! - Keep the `model` parameter static in subagent tool schemas, deliver available subagent models via `<system-reminder>` messages instead of tool descriptions, and reject invalid or resume-time `model` arguments with explicit errors.

- [#5369](https://github.com/MoonshotAI/kimi-code/pull/5369) [`f8375e1`](https://github.com/MoonshotAI/kimi-code/commit/f8375e18b74130ed82b7a314d10916e942c9f73b) Thanks [@markankamaransheogarat-sys](https://github.com/markankamaransheogarat-sys)! - Register Tower mode tools as deferred tools when Tower mode is enabled and unload them when it is disabled, so Tower mode can be toggled at any time in a session.

- [#5257](https://github.com/MoonshotAI/kimi-code/pull/5257) [`a3de86a`](https://github.com/MoonshotAI/kimi-code/commit/a3de86aa53dcbf1a911d19932caf525bf0d4d0bc) Thanks [@sailist](https://github.com/sailist)! - Unify how history is obtained within the agent scope.

- Updated dependencies [[`dbcf39b`](https://github.com/MoonshotAI/kimi-code/commit/dbcf39bddd1d3b68a76782fb3937d8ae3d735b84), [`57200d5`](https://github.com/MoonshotAI/kimi-code/commit/57200d54e5ad95c704e166166023ed1fe4ca4e6a), [`f8375e1`](https://github.com/MoonshotAI/kimi-code/commit/f8375e18b74130ed82b7a314d10916e942c9f73b), [`f56a260`](https://github.com/MoonshotAI/kimi-code/commit/f56a260feec03b5037c1999d24bd8d930b1300e2), [`9dadda1`](https://github.com/MoonshotAI/kimi-code/commit/9dadda17606cf2c44b5e9e6f0b2d2425edd4be4d), [`afa8ef6`](https://github.com/MoonshotAI/kimi-code/commit/afa8ef65ee0f24092c243dca671d17b62ffae0b2), [`1655099`](https://github.com/MoonshotAI/kimi-code/commit/16550990aa7ae3b526abcb2fb045868bebf5c418), [`ba2491c`](https://github.com/MoonshotAI/kimi-code/commit/ba2491ca4b86bd03ae691b36d34f3d7487468d68)]:
  - @moonshot-ai/core@0.2.0

## 0.6.1

### Patch Changes

- [#5246](https://github.com/MoonshotAI/kimi-code/pull/5246) [`f81c924`](https://github.com/MoonshotAI/kimi-code/commit/f81c924b1d70f963b0dc094bcb6859e446c37a49) Thanks [@liruifengv](https://github.com/liruifengv)! - Identify built-in MCP authorization calls and report reconnection and timeout states without appending authorization URLs to failed results.

- [#5300](https://github.com/MoonshotAI/kimi-code/pull/5300) [`fce3af9`](https://github.com/MoonshotAI/kimi-code/commit/fce3af9e694a5a572699546ebe8e28ccf004ed88) Thanks [@Grapedge](https://github.com/Grapedge)! - Record model attribution for reply feedback and support cancellable multipart feedback uploads.

- Updated dependencies [[`fce3af9`](https://github.com/MoonshotAI/kimi-code/commit/fce3af9e694a5a572699546ebe8e28ccf004ed88)]:
  - @moonshot-ai/kimi-code-oauth@0.5.1

## 0.6.0

### Minor Changes

- [#4457](https://github.com/MoonshotAI/kimi-code/pull/4457) [`e2ad1dc`](https://github.com/MoonshotAI/kimi-code/commit/e2ad1dcf214337ecfb5ca160fa36d5ef73560ab6) Thanks [@liruifengv](https://github.com/liruifengv)! - Allow file listings to expose symlinked directories and optionally follow symlinks outside the workspace.

### Patch Changes

- [#4527](https://github.com/MoonshotAI/kimi-code/pull/4527) [`1853dae`](https://github.com/MoonshotAI/kimi-code/commit/1853dae4ff54b36da878a08c86a7088bde0114a8) Thanks [@liruifengv](https://github.com/liruifengv)! - Add batched, folder-scoped Git and pull request queries for multi-root workspace panels.

- [#4525](https://github.com/MoonshotAI/kimi-code/pull/4525) [`8019337`](https://github.com/MoonshotAI/kimi-code/commit/80193374ebb47973a97d21d0b4ce4c27128eee82) Thanks [@liruifengv](https://github.com/liruifengv)! - Support digest-verified marketplace plugin installation and preserve OAuth credentials across configuration changes.

## 0.5.1

### Patch Changes

- Updated dependencies [[`9f0693b`](https://github.com/MoonshotAI/kimi-code/commit/9f0693becb63a329cbf764325688448e76f40922)]:
  - @moonshot-ai/kimi-code-oauth@0.5.0

## 0.5.0

### Minor Changes

- [#4058](https://github.com/MoonshotAI/kimi-code/pull/4058) [`5b93669`](https://github.com/MoonshotAI/kimi-code/commit/5b936697670ed15444bcb4720bd91e6ee776a941) Thanks [@liruifengv](https://github.com/liruifengv)! - Add an `allow_ignored_globs` option to the workspace `fs:list` request: matching entries are listed even when gitignored, ignored ancestor directories of a match stay traversable, and dot-path allowances require `show_hidden: true`.

### Patch Changes

- [#4058](https://github.com/MoonshotAI/kimi-code/pull/4058) [`5b93669`](https://github.com/MoonshotAI/kimi-code/commit/5b936697670ed15444bcb4720bd91e6ee776a941) Thanks [@liruifengv](https://github.com/liruifengv)! - Match workspace fs globs (`include_globs`, `exclude_globs`, `allow_ignored_globs`) with the standard picomatch engine: `a/**/b` no longer matches paths like `a/xxb`, and `a/**` now also matches `a` itself.

## 0.4.3

### Patch Changes

- [#3341](https://github.com/MoonshotAI/kimi-code/pull/3341) [`9fa1e77`](https://github.com/MoonshotAI/kimi-code/commit/9fa1e77df5794cebaa3eb09d01bbe174d55e5a28) Thanks [@7Sageer](https://github.com/7Sageer)! - Remove the `${now}` variable from the system prompt template variable table.

## 0.4.2

### Patch Changes

- [#3289](https://github.com/MoonshotAI/kimi-code/pull/3289) [`f143130`](https://github.com/MoonshotAI/kimi-code/commit/f143130c072e9dba8d60ef40c49d4305b93ab2fe) Thanks [@liruifengv](https://github.com/liruifengv)! - Carry the orchestrator's prompt on subagent turns: `isDisplayablePromptOrigin` now accepts `system_trigger/subagent`, so live `turn.started` events include the prompt, and cold rebuild folds the opening input (text and attachments) into turns opened by subagent run messages. Other system triggers (goal_continuation, stop_hook, loadable-tools) remain promptless.

## 0.4.1

### Patch Changes

- [#3109](https://github.com/MoonshotAI/kimi-code/pull/3109) [`f1208c8`](https://github.com/MoonshotAI/kimi-code/commit/f1208c8d7241e8ef428d83ff235f5a218911b342) Thanks [@liruifengv](https://github.com/liruifengv)! - Rework the session title excerpts: rebalance the segment budgets toward user prompts (400 chars each, assistant 300), cap each prompt in the `user_prompts` excerpt, and compose the `digest` excerpt from the full conversation arc — every natural-language user prompt in the live window paired with its own turn's final assistant text, interleaved chronologically, within per-segment caps and a 3000-char total budget (middle turns elided).

## 0.4.0

### Minor Changes

- [#2351](https://github.com/MoonshotAI/kimi-code/pull/2351) [`6be2697`](https://github.com/MoonshotAI/kimi-code/commit/6be26978b123bacf1c5ebce52bbeb6f7b7ff0629) Thanks [@7Sageer](https://github.com/7Sageer)! - Add the Session-scoped `ISessionTitleService` for managed AI session titles: composes the excerpt sent to the platform chat_title tool from the main agent's conversation (the first user prompts, the strict `first_turn` pair, or the head+tail `digest` for multi-turn sessions; assistant segments keep only final text), persists the result with a `titleKind` (`replaceable` / `generated` / `custom`) that never overwrites a user-renamed title unless explicitly forced, and rebroadcasts `session.meta.updated`. Gated by the new experimental `auto_session_title` flag and a managed OAuth login.

### Patch Changes

- [#2911](https://github.com/MoonshotAI/kimi-code/pull/2911) [`249d8fa`](https://github.com/MoonshotAI/kimi-code/commit/249d8faa3447427665185a900926d048213d2ac7) Thanks [@7Sageer](https://github.com/7Sageer)! - Normalize provider tool call ids at the LLM ingestion boundary (`ToolCallIdNormalizer` in `llmRequester`): self-hosted endpoints may renumber ids per response, and a repeated id corrupted every downstream keying — dropped tool results in context rebuild, `duplicate_tool_call_dropped` in the strict projector, merged transcript frames, misrouted approvals. The first occurrence passes through unchanged; later ones are rewritten to a readable `<id>__<n>` suffix, kept consistent between streamed deltas and the finalized message, logged for provenance, and rolled back when the attempt fails so projection retries re-stream under the same ids. Interaction ids are additionally minted engine-side (`approval_<uuid>` / `question_<uuid>` / `user_tool_<uuid>`) instead of deriving from the provider toolCallId.

- Updated dependencies [[`6be2697`](https://github.com/MoonshotAI/kimi-code/commit/6be26978b123bacf1c5ebce52bbeb6f7b7ff0629), [`4a93f70`](https://github.com/MoonshotAI/kimi-code/commit/4a93f70aa2cf5f70a88b4f8eeb2e409aab2c8f59)]:
  - @moonshot-ai/kimi-code-oauth@0.4.0

## 0.3.2

### Patch Changes

- [#2815](https://github.com/MoonshotAI/kimi-code/pull/2815) [`43c68f5`](https://github.com/MoonshotAI/kimi-code/commit/43c68f58f578c88d9f503afb72f12d343c2aa5c7) Thanks [@liruifengv](https://github.com/liruifengv)! - Keep session updatedAt stable across metadata management writes: rename and archive/restore no longer bump it, fork inherits the source session's recency, and agent registration is non-touching; add SessionMeta.archivedAt (set on archive, cleared on restore) and surface it as archived_at through the session index and the v1/v2 session routes.

## 0.3.1

### Patch Changes

- [#2562](https://github.com/MoonshotAI/kimi-code/pull/2562) [`071b6a5`](https://github.com/MoonshotAI/kimi-code/commit/071b6a50d9c2ce9c4b45dc4d58dac1101b8c4f52) Thanks [@sailist](https://github.com/sailist)! - Serve v1 message history from the server layer and drop the engine-side legacy message adapter; the /api/v1 message contract is unchanged.

## 0.3.0

### Minor Changes

- [#2382](https://github.com/MoonshotAI/kimi-code/pull/2382) [`40172c7`](https://github.com/MoonshotAI/kimi-code/commit/40172c7ca96ca981b043b793588dd32e898979fa) Thanks [@liruifengv](https://github.com/liruifengv)! - Replace the bootstrap `clientVersion` with a required `clientIdentity` host identity object: the OAuth device-flow endpoints now send the full `X-Msh-*` device headers on every host, telemetry reads the client version from the same source, and the session export manifest gains an optional desktop version field.

### Patch Changes

- Updated dependencies [[`40172c7`](https://github.com/MoonshotAI/kimi-code/commit/40172c7ca96ca981b043b793588dd32e898979fa)]:
  - @moonshot-ai/kimi-code-oauth@0.3.0

## 0.2.0

### Minor Changes

- [#1735](https://github.com/MoonshotAI/kimi-code/pull/1735) [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6) Thanks [@7Sageer](https://github.com/7Sageer)! - Let custom agent files restrict which sub-agent types they may delegate to (v2 engine only).

- [#1735](https://github.com/MoonshotAI/kimi-code/pull/1735) [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6) Thanks [@7Sageer](https://github.com/7Sageer)! - Support custom agents defined as Markdown files with frontmatter, usable as the main agent or a sub-agent (v2 engine only).

- [#1735](https://github.com/MoonshotAI/kimi-code/pull/1735) [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6) Thanks [@7Sageer](https://github.com/7Sageer)! - Add global tool gating to constrain which tools agents may use, with a per-session override (v2 engine only).

- [#1735](https://github.com/MoonshotAI/kimi-code/pull/1735) [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6) Thanks [@7Sageer](https://github.com/7Sageer)! - Support overriding the default main-agent system prompt with a user-level file for every session (v2 engine only).

### Patch Changes

- [#2030](https://github.com/MoonshotAI/kimi-code/pull/2030) [`ec88d35`](https://github.com/MoonshotAI/kimi-code/commit/ec88d352e8f4dc5e8ffd1212f016138458f69893) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix catalog-imported Claude models being wrongly locked into always-on thinking, and stop offering a misleading thinking Off option for models that cannot truly disable reasoning (such as Gemini 3). Also normalizes configured thinking effort values and unifies context-usage reporting.

- [#1993](https://github.com/MoonshotAI/kimi-code/pull/1993) [`37eda4e`](https://github.com/MoonshotAI/kimi-code/commit/37eda4e59aebc8ecafa91be3f43f971ed63963a3) Thanks [@RealKai42](https://github.com/RealKai42)! - Add environment variable overrides for agent loop and background task limits. Set KIMI_LOOP_MAX_STEPS_PER_TURN, KIMI_LOOP_MAX_RETRIES_PER_STEP, or KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS to take priority over the [loop_control] and [background] config.

- [#1993](https://github.com/MoonshotAI/kimi-code/pull/1993) [`37eda4e`](https://github.com/MoonshotAI/kimi-code/commit/37eda4e59aebc8ecafa91be3f43f971ed63963a3) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix config environment overrides (such as KIMI_IMAGE_MAX_EDGE_PX or KIMI_SUBAGENT_TIMEOUT_MS) being persisted into config.toml by config API writes while the env var is set, and keeping the old value after the env var is changed to an invalid value or removed.

- [#1968](https://github.com/MoonshotAI/kimi-code/pull/1968) [`71bcfba`](https://github.com/MoonshotAI/kimi-code/commit/71bcfba54a6836f4b6d4e26babde67576b293a64) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix sessions getting stuck on every turn with a provider "message must not be empty" error after a content-filtered response.

- [#2015](https://github.com/MoonshotAI/kimi-code/pull/2015) [`b5efba7`](https://github.com/MoonshotAI/kimi-code/commit/b5efba7abcaf4041f81ec520097a61e6546e8c50) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix thinking levels being offered for models that do not support them (e.g. phantom levels on Kimi K3): levels now come from each model's declared capabilities. Models that cannot disable reasoning (e.g. gpt-5) no longer offer an Off option, and turning thinking Off on models that support it (e.g. xai grok) now truly disables reasoning.

- [#1735](https://github.com/MoonshotAI/kimi-code/pull/1735) [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6) Thanks [@7Sageer](https://github.com/7Sageer)! - Warn when a tool allow/deny list entry can never match any tool, for example a misspelled name (v2 engine only).

- Updated dependencies [[`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6), [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6), [`a3699dd`](https://github.com/MoonshotAI/kimi-code/commit/a3699dd6aa7b41efd3129a117007d195282379fd)]:
  - @moonshot-ai/protocol@0.5.0

## 0.1.2

### Patch Changes

- [#1888](https://github.com/MoonshotAI/kimi-code/pull/1888) [`5ae60fa`](https://github.com/MoonshotAI/kimi-code/commit/5ae60fa6736b63b80bd764ef01d6c0334eb80595) Thanks [@sailist](https://github.com/sailist)! - Add a unified, agent-granular transcript rendering data layer and serve it from the v2 server: clients can fetch turn-paginated transcripts via `GET /sessions/{id}/transcript` and subscribe to per-agent transcript updates over the v1 WebSocket with per-connection granularity control (off / turn / block / delta). All transcript wire types are owned by the transcript package itself. `turn.started` now carries the turn's prompt text so live transcripts render the user input as soon as the turn opens.

## 0.1.1

### Patch Changes

- Updated dependencies [[`44f3341`](https://github.com/MoonshotAI/kimi-code/commit/44f334191989183d21920f6867c405581347c748), [`44f3341`](https://github.com/MoonshotAI/kimi-code/commit/44f334191989183d21920f6867c405581347c748), [`44f3341`](https://github.com/MoonshotAI/kimi-code/commit/44f334191989183d21920f6867c405581347c748), [`44f3341`](https://github.com/MoonshotAI/kimi-code/commit/44f334191989183d21920f6867c405581347c748)]:
  - @moonshot-ai/minidb@0.2.0

## 0.1.0

### Minor Changes

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Track the agent's live phase (idle, running, streaming, tool call, retrying, awaiting approval, interrupted, ended) as a single model field driven by the existing turn events, and carry it on the status update channel for downstream consumers.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Persist v2 wire records natively in the v1 record vocabulary and remove the persist-time rewrite layer: ops now write v1-shaped records directly (todo updates persist as `tools.update_store`, `turn.prompt` carries only `input`/`origin`, `usage.record` drops request context, `plan_mode.enter` carries only the plan id), live-only state (runtime phase, task/cron registries, context size, skill activations, runtime permission rules) is declared `persist: false` instead of being stripped at write time, and the swarm-mode exit reminder removal replays from the `swarm_mode.exit` record itself. This fixes resumed sessions losing the todo list, drifting turn counters after retries, and removed reminders reappearing after resume.

### Patch Changes

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Fix the v2 AskUserQuestion flow: answers now come back keyed by question text with option labels as values, aborting a turn or stopping a background question dismisses the pending question instead of leaking it, and duplicate question texts or option labels are rejected before the question is shown. The pending-question wire shape no longer carries a synthetic expires_at field.

- [#1638](https://github.com/MoonshotAI/kimi-code/pull/1638) [`7c889f3`](https://github.com/MoonshotAI/kimi-code/commit/7c889f3a960482cc9382203bda55d972b6fb6acd) Thanks [@RealKai42](https://github.com/RealKai42)! - In auto permission mode, plan exits are now marked as auto-approved (not user-reviewed) in both the tool result and the transcript, so the agent no longer treats automatic plan approval as a user signal to start executing.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Fix the production build by resolving internal module imports directly instead of through directory re-exports.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Reorganize the agent execution environment into separate filesystem, process and tool domains.

- [#1629](https://github.com/MoonshotAI/kimi-code/pull/1629) [`0527ca2`](https://github.com/MoonshotAI/kimi-code/commit/0527ca2267f8cf355d0c158953f3dbfc0c9692ac) Thanks [@sailist](https://github.com/sailist)! - Fix session fork losing everything except the conversation log: forked sessions now carry over media attachments, plan files, background task output, and cron tasks, and a failed fork no longer leaves a broken half-copy behind.

- [#1663](https://github.com/MoonshotAI/kimi-code/pull/1663) [`1294a0e`](https://github.com/MoonshotAI/kimi-code/commit/1294a0e1ad739151573163505f9c58afb2d543e4) Thanks [@7Sageer](https://github.com/7Sageer)! - Fix OAuth login hanging after browser authorization when the provider configuration changes during sign-in.

- [#1632](https://github.com/MoonshotAI/kimi-code/pull/1632) [`a4aae87`](https://github.com/MoonshotAI/kimi-code/commit/a4aae87cd9a240d3567601ed1a9aefaab540b075) Thanks [@sailist](https://github.com/sailist)! - Fix providers without a configured base_url being rejected: anthropic/openai and other protocol providers now fall back to their official default endpoints again, as before.

- [#1629](https://github.com/MoonshotAI/kimi-code/pull/1629) [`0527ca2`](https://github.com/MoonshotAI/kimi-code/commit/0527ca2267f8cf355d0c158953f3dbfc0c9692ac) Thanks [@sailist](https://github.com/sailist)! - Fix the v2 engine never activating tool-call deduplication: identical tool calls issued in the same step no longer execute multiple times, and repeated identical calls across steps receive escalating reminders again.

- [#1636](https://github.com/MoonshotAI/kimi-code/pull/1636) [`8027fe2`](https://github.com/MoonshotAI/kimi-code/commit/8027fe291b03fbfce6dc60aa06f8699ad0976ec5) Thanks [@sailist](https://github.com/sailist)! - Fix caller-supplied MCP servers being silently dropped when creating a session through the v2 engine (experimental).

- [#1636](https://github.com/MoonshotAI/kimi-code/pull/1636) [`8027fe2`](https://github.com/MoonshotAI/kimi-code/commit/8027fe291b03fbfce6dc60aa06f8699ad0976ec5) Thanks [@sailist](https://github.com/sailist)! - Make file tools able to reach skill directories outside the working directory in the v2 engine (experimental), and honor --skillsDir in v2 print mode and the server's skillDirs option.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Reroute the blob store backend from the host filesystem to the pluggable storage layer, so server-only deployments no longer require a local filesystem implementation.

- [#1637](https://github.com/MoonshotAI/kimi-code/pull/1637) [`0e0a6e9`](https://github.com/MoonshotAI/kimi-code/commit/0e0a6e9a5170c28c5e6809c1b2cf6d6f8904de73) Thanks [@sailist](https://github.com/sailist)! - Support caller-supplied MCP server configs on session create in the v2 engine (experimental), merged over the file config and under plugin servers.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Route FetchURL through the managed Kimi fetch service when the Kimi provider is logged in, with automatic fallback to local fetching on failure, and forward the host identity headers with the request.

- [#1634](https://github.com/MoonshotAI/kimi-code/pull/1634) [`96b8328`](https://github.com/MoonshotAI/kimi-code/commit/96b83281b2da3ee479b59e8a8da990708d1d6a30) Thanks [@sailist](https://github.com/sailist)! - Fix v2 managed OAuth login ignoring `KIMI_CODE_BASE_URL` / `KIMI_CODE_OAUTH_HOST`: the login environment is now resolved env-aware (v1 parity), so the credential slot a token is written to always matches the slot the runtime reads — no more "login succeeds but every call 401s" against non-default environments. The provisioned provider entry records the login environment and credential slot explicitly, and logout deletes from the runtime (env-aware) slot.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Hide image-compression captions from user-visible history: captions that prompt ingestion places inside a user message are rerouted through hidden system reminders (and stripped from session titles), while the model still receives the full note. ReadMediaFile is now registered in production whenever the bound model supports image or video input, re-registering on model switches.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Align v2 media reads with v1: the ReadMediaFile summary moves to the tool result's note side channel so raw `<system>` markup never renders in UIs, image dimensions are reported in the decoded EXIF-rotated space so portrait photos get correct coordinate guidance, the downscale cap rises from 2000px to 3000px with a gentler byte-budget fallback, and image compression and crop telemetry is reported for media reads.

- [#1633](https://github.com/MoonshotAI/kimi-code/pull/1633) [`5d1f904`](https://github.com/MoonshotAI/kimi-code/commit/5d1f9049cab84c0f40524a2382b085dfa976c866) Thanks [@sailist](https://github.com/sailist)! - Fix the v2 messages API serving broken history after resume: restored `blobref:` media URLs are rehydrated to inline `data:` URIs from the agent's blob store (matching live emissions), tool results carrying media (e.g. ReadMediaFile) pass their content parts through instead of being flattened to empty text, and `created_at` uses the wire record time instead of a synthesized session-start offset.

- [#1677](https://github.com/MoonshotAI/kimi-code/pull/1677) [`003e583`](https://github.com/MoonshotAI/kimi-code/commit/003e583d865d40ae7dbeb0f1e6b3974a63781950) Thanks [@sailist](https://github.com/sailist)! - Fix the v2 model catalog response omitting support_efforts and default_effort, restoring thinking-effort selection for clients connected to the v2 backend.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Fix the managed OAuth device-code login getting aborted when an unrelated provider refresh fires during the login flow.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Harden plugin management: degrade sessions gracefully when plugin state fails to load, clean up temp dirs and roll back the managed copy on failed installs, restore managed endpoint env for stdio plugin MCP servers, and make update checks concurrent with per-repo failure isolation.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Forward the host identity headers (User-Agent and device identity) with WebSearch requests, matching v1.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Align v2 engine telemetry with the v1 wire format: rename `tool_call_dedupe_detected` to `tool_call_dedup_detected`, carry mode/protocol tags on turn events, emit `turn_ended` unconditionally with interrupt reasons, add alias/protocol/input token fields to `api_error`, tag `tool_call` with `dup_type`, rename compaction usage fields to `input_tokens`/`output_tokens`, and add `context_projection_repaired`, `session_started`, and `session_load_failed` events.

- [#1602](https://github.com/MoonshotAI/kimi-code/pull/1602) [`09c1c32`](https://github.com/MoonshotAI/kimi-code/commit/09c1c3296059255a5074fa5d4dbb22fef14cdef9) Thanks [@kermanx](https://github.com/kermanx)! - Align the v2 engine with v1 on several parity gaps: the auto permission mode reminder is re-announced after compaction instead of being lost, goal reminders and the background-task reminder now match v1's exact text, and the goal tools are main-agent-only again.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Report `video_upload` telemetry for ReadMediaFile video uploads — outcome, byte size, mime type, duration, and model/protocol tags; a failing telemetry sink never affects the upload.

- Updated dependencies [[`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6), [`0303b82`](https://github.com/MoonshotAI/kimi-code/commit/0303b82c3e691836163ecf906febfb6324c81d74)]:
  - @moonshot-ai/protocol@0.4.0
