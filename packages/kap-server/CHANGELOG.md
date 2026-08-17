# @moonshot-ai/kap-server

## 0.2.2

### Patch Changes

- [#2351](https://github.com/MoonshotAI/kimi-code/pull/2351) [`6be2697`](https://github.com/MoonshotAI/kimi-code/commit/6be26978b123bacf1c5ebce52bbeb6f7b7ff0629) Thanks [@7Sageer](https://github.com/7Sageer)! - Add `POST /api/v1/sessions/{session_id}/title/generate` with an optional `{ "force": true, "source": "user_prompts" | "first_turn" | "digest" }` body; unknown sessions return 40401 and unavailable generation (flag off, no managed login, no prompt yet, backend failure) returns the new 40923 SESSION_TITLE_UNAVAILABLE.

- Updated dependencies [[`6be2697`](https://github.com/MoonshotAI/kimi-code/commit/6be26978b123bacf1c5ebce52bbeb6f7b7ff0629), [`6be2697`](https://github.com/MoonshotAI/kimi-code/commit/6be26978b123bacf1c5ebce52bbeb6f7b7ff0629), [`4a93f70`](https://github.com/MoonshotAI/kimi-code/commit/4a93f70aa2cf5f70a88b4f8eeb2e409aab2c8f59), [`249d8fa`](https://github.com/MoonshotAI/kimi-code/commit/249d8faa3447427665185a900926d048213d2ac7)]:
  - @moonshot-ai/agent-core-v2@0.4.0
  - @moonshot-ai/kimi-code-oauth@0.4.0

## 0.2.1

### Patch Changes

- [#2572](https://github.com/MoonshotAI/kimi-code/pull/2572) [`6ba75a1`](https://github.com/MoonshotAI/kimi-code/commit/6ba75a173b595904bc70d0d7161de2f9b964c961) Thanks [@sailist](https://github.com/sailist)! - Add the global `event.config.warning` WebSocket event that pushes the current set of config warnings (deprecated config keys or environment variables in use) to every connection whenever it changes.

- [#2417](https://github.com/MoonshotAI/kimi-code/pull/2417) [`e22479a`](https://github.com/MoonshotAI/kimi-code/commit/e22479a62eed9c3b78a67b313f4332c2c0ba9670) Thanks [@liruifengv](https://github.com/liruifengv)! - Expose the effective experimental-flag map as `experimental_flags` on `GET /api/v1/meta`.

- [#2585](https://github.com/MoonshotAI/kimi-code/pull/2585) [`c396873`](https://github.com/MoonshotAI/kimi-code/commit/c39687318c64bf8a305a10bf9ca86ef6ef2c6656) Thanks [@sailist](https://github.com/sailist)! - Fix submitting answers to interactive question prompts being rejected when the model provider returns tool call IDs containing colons (some OpenAI-compatible gateways).

- [#2562](https://github.com/MoonshotAI/kimi-code/pull/2562) [`071b6a5`](https://github.com/MoonshotAI/kimi-code/commit/071b6a50d9c2ce9c4b45dc4d58dac1101b8c4f52) Thanks [@sailist](https://github.com/sailist)! - Serve v1 message history from the server layer and drop the engine-side legacy message adapter; the /api/v1 message contract is unchanged.

- [#2562](https://github.com/MoonshotAI/kimi-code/pull/2562) [`071b6a5`](https://github.com/MoonshotAI/kimi-code/commit/071b6a50d9c2ce9c4b45dc4d58dac1101b8c4f52) Thanks [@sailist](https://github.com/sailist)! - Assemble the session snapshot endpoint from the engine's services for both cold and live sessions, and remove the KIMI_SNAPSHOT_READER, KIMI_SNAPSHOT_TIMEOUT_MS, and KIMI_SNAPSHOT_CACHE_LIMIT environment knobs.

- Updated dependencies [[`071b6a5`](https://github.com/MoonshotAI/kimi-code/commit/071b6a50d9c2ce9c4b45dc4d58dac1101b8c4f52)]:
  - @moonshot-ai/agent-core-v2@0.3.1

## 0.2.0

### Minor Changes

- [#2382](https://github.com/MoonshotAI/kimi-code/pull/2382) [`40172c7`](https://github.com/MoonshotAI/kimi-code/commit/40172c7ca96ca981b043b793588dd32e898979fa) Thanks [@liruifengv](https://github.com/liruifengv)! - Require a `hostIdentity` when starting the server and derive the default outbound identity headers (User-Agent + `X-Msh-*`) from it, replacing the hardcoded CLI fallback. The `version` option is renamed to `serverVersion`, and session export manifests now record the host product version — plus an optional desktop version for desktop exports — instead of the engine version.

### Patch Changes

- Updated dependencies [[`40172c7`](https://github.com/MoonshotAI/kimi-code/commit/40172c7ca96ca981b043b793588dd32e898979fa), [`40172c7`](https://github.com/MoonshotAI/kimi-code/commit/40172c7ca96ca981b043b793588dd32e898979fa)]:
  - @moonshot-ai/kimi-code-oauth@0.3.0
  - @moonshot-ai/agent-core-v2@0.3.0

## 0.1.0

### Minor Changes

- [#1735](https://github.com/MoonshotAI/kimi-code/pull/1735) [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6) Thanks [@7Sageer](https://github.com/7Sageer)! - Support custom agents defined as Markdown files with frontmatter, usable as the main agent or a sub-agent (v2 engine only).

- [#1735](https://github.com/MoonshotAI/kimi-code/pull/1735) [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6) Thanks [@7Sageer](https://github.com/7Sageer)! - Add global tool gating to constrain which tools agents may use, with a per-session override (v2 engine only).

### Patch Changes

- [#2030](https://github.com/MoonshotAI/kimi-code/pull/2030) [`ec88d35`](https://github.com/MoonshotAI/kimi-code/commit/ec88d352e8f4dc5e8ffd1212f016138458f69893) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix catalog-imported Claude models being wrongly locked into always-on thinking, and stop offering a misleading thinking Off option for models that cannot truly disable reasoning (such as Gemini 3). Also normalizes configured thinking effort values and unifies context-usage reporting.

- [#2005](https://github.com/MoonshotAI/kimi-code/pull/2005) [`a3699dd`](https://github.com/MoonshotAI/kimi-code/commit/a3699dd6aa7b41efd3129a117007d195282379fd) Thanks [@7Sageer](https://github.com/7Sageer)! - Add an `active` flag to each tool in the server's tool listing API.

- Updated dependencies [[`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6), [`ec88d35`](https://github.com/MoonshotAI/kimi-code/commit/ec88d352e8f4dc5e8ffd1212f016138458f69893), [`37eda4e`](https://github.com/MoonshotAI/kimi-code/commit/37eda4e59aebc8ecafa91be3f43f971ed63963a3), [`37eda4e`](https://github.com/MoonshotAI/kimi-code/commit/37eda4e59aebc8ecafa91be3f43f971ed63963a3), [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6), [`71bcfba`](https://github.com/MoonshotAI/kimi-code/commit/71bcfba54a6836f4b6d4e26babde67576b293a64), [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6), [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6), [`b5efba7`](https://github.com/MoonshotAI/kimi-code/commit/b5efba7abcaf4041f81ec520097a61e6546e8c50), [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6)]:
  - @moonshot-ai/agent-core-v2@0.2.0

## 0.0.2

### Patch Changes

- [#1888](https://github.com/MoonshotAI/kimi-code/pull/1888) [`5ae60fa`](https://github.com/MoonshotAI/kimi-code/commit/5ae60fa6736b63b80bd764ef01d6c0334eb80595) Thanks [@sailist](https://github.com/sailist)! - Add a unified, agent-granular transcript rendering data layer and serve it from the v2 server: clients can fetch turn-paginated transcripts via `GET /sessions/{id}/transcript` and subscribe to per-agent transcript updates over the v1 WebSocket with per-connection granularity control (off / turn / block / delta). All transcript wire types are owned by the transcript package itself. `turn.started` now carries the turn's prompt text so live transcripts render the user input as soon as the turn opens.

- Updated dependencies [[`5ae60fa`](https://github.com/MoonshotAI/kimi-code/commit/5ae60fa6736b63b80bd764ef01d6c0334eb80595)]:
  - @moonshot-ai/transcript@0.0.1
  - @moonshot-ai/agent-core-v2@0.1.2

## 0.0.1

### Patch Changes

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Fix the v2 AskUserQuestion flow: answers now come back keyed by question text with option labels as values, aborting a turn or stopping a background question dismisses the pending question instead of leaking it, and duplicate question texts or option labels are rejected before the question is shown. The pending-question wire shape no longer carries a synthetic expires_at field.

- [#1638](https://github.com/MoonshotAI/kimi-code/pull/1638) [`7c889f3`](https://github.com/MoonshotAI/kimi-code/commit/7c889f3a960482cc9382203bda55d972b6fb6acd) Thanks [@RealKai42](https://github.com/RealKai42)! - In auto permission mode, plan exits are now marked as auto-approved (not user-reviewed) in both the tool result and the transcript, so the agent no longer treats automatic plan approval as a user signal to start executing.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Reorganize the agent execution environment into separate filesystem, process and tool domains.

- [#1636](https://github.com/MoonshotAI/kimi-code/pull/1636) [`8027fe2`](https://github.com/MoonshotAI/kimi-code/commit/8027fe291b03fbfce6dc60aa06f8699ad0976ec5) Thanks [@sailist](https://github.com/sailist)! - Make file tools able to reach skill directories outside the working directory in the v2 engine (experimental), and honor --skillsDir in v2 print mode and the server's skillDirs option.

- [#1601](https://github.com/MoonshotAI/kimi-code/pull/1601) [`dc309a7`](https://github.com/MoonshotAI/kimi-code/commit/dc309a7dfb38b6ef885b8ae80be51b49f8486207) Thanks [@kermanx](https://github.com/kermanx)! - Report the live (measured + estimated) context size in the v2 server's v1-compatible status stream instead of the measured-only count, which read 0 until the first model response of a session completed and could dip mid-turn while the context was being rewritten.

- [#1617](https://github.com/MoonshotAI/kimi-code/pull/1617) [`4ec2e7f`](https://github.com/MoonshotAI/kimi-code/commit/4ec2e7fab14ab89cddf77821082c3ff4911f737b) Thanks [@sailist](https://github.com/sailist)! - Run the local server (`kimi server run` / `kimi web`) on the agent-core-v2 engine by default — the `KIMI_CODE_EXPERIMENTAL_FLAG` opt-in is no longer needed, and the legacy v1 server package has been removed.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Reroute the blob store backend from the host filesystem to the pluggable storage layer, so server-only deployments no longer require a local filesystem implementation.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Fix the managed OAuth device-code login getting aborted when an unrelated provider refresh fires during the login flow.

- Updated dependencies [[`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6), [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6), [`7c889f3`](https://github.com/MoonshotAI/kimi-code/commit/7c889f3a960482cc9382203bda55d972b6fb6acd), [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6), [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6), [`0527ca2`](https://github.com/MoonshotAI/kimi-code/commit/0527ca2267f8cf355d0c158953f3dbfc0c9692ac), [`1294a0e`](https://github.com/MoonshotAI/kimi-code/commit/1294a0e1ad739151573163505f9c58afb2d543e4), [`a4aae87`](https://github.com/MoonshotAI/kimi-code/commit/a4aae87cd9a240d3567601ed1a9aefaab540b075), [`0303b82`](https://github.com/MoonshotAI/kimi-code/commit/0303b82c3e691836163ecf906febfb6324c81d74), [`0527ca2`](https://github.com/MoonshotAI/kimi-code/commit/0527ca2267f8cf355d0c158953f3dbfc0c9692ac), [`8027fe2`](https://github.com/MoonshotAI/kimi-code/commit/8027fe291b03fbfce6dc60aa06f8699ad0976ec5), [`8027fe2`](https://github.com/MoonshotAI/kimi-code/commit/8027fe291b03fbfce6dc60aa06f8699ad0976ec5), [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6), [`0e0a6e9`](https://github.com/MoonshotAI/kimi-code/commit/0e0a6e9a5170c28c5e6809c1b2cf6d6f8904de73), [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6), [`96b8328`](https://github.com/MoonshotAI/kimi-code/commit/96b83281b2da3ee479b59e8a8da990708d1d6a30), [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6), [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6), [`5d1f904`](https://github.com/MoonshotAI/kimi-code/commit/5d1f9049cab84c0f40524a2382b085dfa976c866), [`003e583`](https://github.com/MoonshotAI/kimi-code/commit/003e583d865d40ae7dbeb0f1e6b3974a63781950), [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6), [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6), [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6), [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6), [`09c1c32`](https://github.com/MoonshotAI/kimi-code/commit/09c1c3296059255a5074fa5d4dbb22fef14cdef9), [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6), [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6)]:
  - @moonshot-ai/agent-core-v2@0.1.0
  - @moonshot-ai/protocol@0.4.0
