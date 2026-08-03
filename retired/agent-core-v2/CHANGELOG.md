# @moonshot-ai/agent-core-v2

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

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Fix the production build by resolving internal module imports directly instead of through directory re-exports.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Reorganize the agent execution environment into separate filesystem, process and tool domains.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Reroute the blob store backend from the host filesystem to the pluggable storage layer, so server-only deployments no longer require a local filesystem implementation.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Route FetchURL through the managed Kimi fetch service when the Kimi provider is logged in, with automatic fallback to local fetching on failure, and forward the host identity headers with the request.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Hide image-compression captions from user-visible history: captions that prompt ingestion places inside a user message are rerouted through hidden system reminders (and stripped from session titles), while the model still receives the full note. ReadMediaFile is now registered in production whenever the bound model supports image or video input, re-registering on model switches.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Align v2 media reads with v1: the ReadMediaFile summary moves to the tool result's note side channel so raw `<system>` markup never renders in UIs, image dimensions are reported in the decoded EXIF-rotated space so portrait photos get correct coordinate guidance, the downscale cap rises from 2000px to 3000px with a gentler byte-budget fallback, and image compression and crop telemetry is reported for media reads.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Fix the managed OAuth device-code login getting aborted when an unrelated provider refresh fires during the login flow.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Harden plugin management: degrade sessions gracefully when plugin state fails to load, clean up temp dirs and roll back the managed copy on failed installs, restore managed endpoint env for stdio plugin MCP servers, and make update checks concurrent with per-repo failure isolation.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Forward the host identity headers (User-Agent and device identity) with WebSearch requests, matching v1.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Align v2 engine telemetry with the v1 wire format: rename `tool_call_dedupe_detected` to `tool_call_dedup_detected`, carry mode/protocol tags on turn events, emit `turn_ended` unconditionally with interrupt reasons, add alias/protocol/input token fields to `api_error`, tag `tool_call` with `dup_type`, rename compaction usage fields to `input_tokens`/`output_tokens`, and add `context_projection_repaired`, `session_started`, and `session_load_failed` events.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Report `video_upload` telemetry for ReadMediaFile video uploads — outcome, byte size, mime type, duration, and model/protocol tags; a failing telemetry sink never affects the upload.

- Updated dependencies [[`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6)]:
  - @moonshot-ai/protocol@0.4.0
