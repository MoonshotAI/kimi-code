# @moonshot-ai/agent-core-v2

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
