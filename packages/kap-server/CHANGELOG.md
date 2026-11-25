# @moonshot-ai/kap-server

## 0.4.0

### Minor Changes

- [#5352](https://github.com/MoonshotAI/kimi-code/pull/5352) [`2b1b095`](https://github.com/MoonshotAI/kimi-code/commit/2b1b095f3bbf48e83632b0aaaabce6773caf4469) Thanks [@sailist](https://github.com/sailist)! - Accept and return `default_swarm_mode` in the host config API (`GET/POST /api/v1/config`).

- [#5290](https://github.com/MoonshotAI/kimi-code/pull/5290) [`13b09d9`](https://github.com/MoonshotAI/kimi-code/commit/13b09d994985d7747572730400be6ef89e722ab6) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Add `workspace_root` to `POST /api/v1/sessions` to choose the project, and report `workspace_root`, `environment_id`, and `environment_cwd` on every session view plus `environment_cwd` on `GET /api/v1/sessions/{session_id}/environment`. The request `cwd` and `metadata.cwd`, the session `cwd`, and the environment `cwd` still work and are marked deprecated. A create request with neither `workspace_id` nor a project root now reports `workspace_root` in its 40001 details.

- [#5383](https://github.com/MoonshotAI/kimi-code/pull/5383) [`ecc92e3`](https://github.com/MoonshotAI/kimi-code/commit/ecc92e33841bc99d547df67aa152174fa8507368) Thanks [@sailist](https://github.com/sailist)! - Expose `continuation` (`"turn"`, `"background"`, or `"none"`) on ended conversation turns in WebSocket frames and REST turn pages to indicate whether another turn follows, background tasks are still running, or all work has finished.

### Patch Changes

- [#5262](https://github.com/MoonshotAI/kimi-code/pull/5262) [`1426175`](https://github.com/MoonshotAI/kimi-code/commit/142617544d8b36501671fe2deefe7303beb14aab) Thanks [@liruifengv](https://github.com/liruifengv)! - Add an allowlisted PUT /api/v1/fs:content endpoint for conditional text-file replacement.

- [#5250](https://github.com/MoonshotAI/kimi-code/pull/5250) [`e9538e3`](https://github.com/MoonshotAI/kimi-code/commit/e9538e370478a47f3f9051779ea4d4eba0265e75) Thanks [@RealKai42](https://github.com/RealKai42)! - Server shutdown now waits for the engine to finish disposing its services, so file watchers on the data and workspace directories are closed before shutdown completes.

- [#5185](https://github.com/MoonshotAI/kimi-code/pull/5185) [`89d9217`](https://github.com/MoonshotAI/kimi-code/commit/89d92177cf8a146ae53077111c4a04ae9b6624dd) Thanks [@liruifengv](https://github.com/liruifengv)! - Allow HTTPS image sources in the Content Security Policy for non-loopback web servers.

- [#5175](https://github.com/MoonshotAI/kimi-code/pull/5175) [`ca71dc2`](https://github.com/MoonshotAI/kimi-code/commit/ca71dc29525184b5fe81e1ac52911c8dd228b20b) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Report context items by where each message came from. User-role messages now come back as `user`, `reminder`, `skill`, or `compaction` items named after their source, and each thinking block, reply text, and tool call of a model message is listed as its own item with a `segment` field.

- [#5344](https://github.com/MoonshotAI/kimi-code/pull/5344) [`c7d3576`](https://github.com/MoonshotAI/kimi-code/commit/c7d3576d85184eb15b7c6f8f1428986003f0280e) Thanks [@chengluyu](https://github.com/chengluyu)! - Append the content parts of an open step to the conversation without scanning the items already in its turn, so folding a step with many content blocks no longer takes quadratic time on the server's main thread.

- [#5047](https://github.com/MoonshotAI/kimi-code/pull/5047) [`f9ee8bb`](https://github.com/MoonshotAI/kimi-code/commit/f9ee8bbf4dee5b12bb7ba66e5824dc5386e30c3b) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Add `POST /api/v1/sessions/{session_id}/agents/{agent_id}:close` (advertised via `meta.capabilities.agent_close`) backed by `ISessionBtwService.close`, `IAgentLifecycleService.removeById`, and `ISessionMetadata.unregisterAgent` to abort and remove side-channel (`btw`) agents.

- [#5290](https://github.com/MoonshotAI/kimi-code/pull/5290) [`13b09d9`](https://github.com/MoonshotAI/kimi-code/commit/13b09d994985d7747572730400be6ef89e722ab6) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Report the session's own `cwd` in the `POST /api/v1/sessions` response and the pushed session-created frame, matching `GET`, the session list, and `:wait`, instead of the registered workspace root.

- [#5391](https://github.com/MoonshotAI/kimi-code/pull/5391) [`5bd5009`](https://github.com/MoonshotAI/kimi-code/commit/5bd500987ed31a7278bfc59da043a6626172c46c) Thanks [@Grapedge](https://github.com/Grapedge)! - Accept `menu` as a global feedback source on `POST /api/v1/feedback`.

- [#5048](https://github.com/MoonshotAI/kimi-code/pull/5048) [`b695ed9`](https://github.com/MoonshotAI/kimi-code/commit/b695ed92af39e2da8a73833926604160071d8bf5) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Add `POST /api/v1/sessions/{session_id}:continue` (advertised via `meta.capabilities.session_continue`) with error code `40940 TURN_NOT_CONTINUABLE` to continue an interrupted or non-blocked failed turn without inserting a synthetic user message.

- [#5068](https://github.com/MoonshotAI/kimi-code/pull/5068) [`31d776c`](https://github.com/MoonshotAI/kimi-code/commit/31d776c469b4b98a6d01a29f5c0d17b6825882e3) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Add `home_dir` to `GET /api/v1/meta`: the absolute path of the data directory the server runs on.

- [#5248](https://github.com/MoonshotAI/kimi-code/pull/5248) [`c4661d1`](https://github.com/MoonshotAI/kimi-code/commit/c4661d1b2aa4bb22dee7ee35f3589ca35f0e97f6) Thanks [@RealKai42](https://github.com/RealKai42)! - Reject a missing web asset build and a non-loopback bind without TLS before the server registers an instance or writes to the home directory, and release the instance registration and the agent engine when any later startup step fails, so a failed start no longer leaves a live instance entry or background writers in the home directory.

- [#5058](https://github.com/MoonshotAI/kimi-code/pull/5058) [`638fd94`](https://github.com/MoonshotAI/kimi-code/commit/638fd94b6c22589253570b9b90dbe5359849ddc2) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Add `GET /api/v1/sessions/{session_id}/context/summary`, `/context/items`, and `/context/items/{item_id}`, which return an unresolved read-only snapshot of the agent's system prompt, baseline tool definitions, and raw messages for context inspection and token estimation.

- [#5347](https://github.com/MoonshotAI/kimi-code/pull/5347) [`cafb392`](https://github.com/MoonshotAI/kimi-code/commit/cafb392f8341d578afd3b725a8df8b1a87a9fcb0) Thanks [@RealKai42](https://github.com/RealKai42)! - Report the pending interaction as it is at the moment a `session` update frame is sent over WebSocket, so a session frame no longer reports `pending_interaction: "none"` after the frame of an interaction that is still pending. The other fields of a frame pushed for an activity change still describe that change.

- [#5068](https://github.com/MoonshotAI/kimi-code/pull/5068) [`31d776c`](https://github.com/MoonshotAI/kimi-code/commit/31d776c469b4b98a6d01a29f5c0d17b6825882e3) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Add a `query` parameter to `GET /api/v1/sessions` that keeps sessions whose title or last prompt contains the text, case-insensitively, or whose id equals it.

- [#5190](https://github.com/MoonshotAI/kimi-code/pull/5190) [`1ef139e`](https://github.com/MoonshotAI/kimi-code/commit/1ef139e6c32a01c7ac51a89fea6ae279c91bc276) Thanks [@7Sageer](https://github.com/7Sageer)! - Keep the `model` parameter static in subagent tool schemas, deliver available subagent models via `<system-reminder>` messages instead of tool descriptions, and reject invalid or resume-time `model` arguments with explicit errors.

- Updated dependencies [[`b53e7a8`](https://github.com/MoonshotAI/kimi-code/commit/b53e7a8b5bb0a485ec4a67e65f0ce92d1fa919f2), [`c0e9faf`](https://github.com/MoonshotAI/kimi-code/commit/c0e9faf0bda52462e034d938f41a3aa48a2e6426), [`dbcf39b`](https://github.com/MoonshotAI/kimi-code/commit/dbcf39bddd1d3b68a76782fb3937d8ae3d735b84), [`57200d5`](https://github.com/MoonshotAI/kimi-code/commit/57200d54e5ad95c704e166166023ed1fe4ca4e6a), [`2b1b095`](https://github.com/MoonshotAI/kimi-code/commit/2b1b095f3bbf48e83632b0aaaabce6773caf4469), [`f8375e1`](https://github.com/MoonshotAI/kimi-code/commit/f8375e18b74130ed82b7a314d10916e942c9f73b), [`6bdb7ea`](https://github.com/MoonshotAI/kimi-code/commit/6bdb7ead8cb5c5b5982ebd59c912ae36010bdfa3), [`f56a260`](https://github.com/MoonshotAI/kimi-code/commit/f56a260feec03b5037c1999d24bd8d930b1300e2), [`f9ee8bb`](https://github.com/MoonshotAI/kimi-code/commit/f9ee8bbf4dee5b12bb7ba66e5824dc5386e30c3b), [`9f04403`](https://github.com/MoonshotAI/kimi-code/commit/9f0440376150f9f2a94419c1ad8984991f7099db), [`f8375e1`](https://github.com/MoonshotAI/kimi-code/commit/f8375e18b74130ed82b7a314d10916e942c9f73b), [`3d7f4c1`](https://github.com/MoonshotAI/kimi-code/commit/3d7f4c10e7967ebac6832b9cf17ebb3024d477f5), [`9dadda1`](https://github.com/MoonshotAI/kimi-code/commit/9dadda17606cf2c44b5e9e6f0b2d2425edd4be4d), [`9dadda1`](https://github.com/MoonshotAI/kimi-code/commit/9dadda17606cf2c44b5e9e6f0b2d2425edd4be4d), [`afa8ef6`](https://github.com/MoonshotAI/kimi-code/commit/afa8ef65ee0f24092c243dca671d17b62ffae0b2), [`92ea0c6`](https://github.com/MoonshotAI/kimi-code/commit/92ea0c6dc3bf718c5a237e28db2d7e2c83978419), [`92ea0c6`](https://github.com/MoonshotAI/kimi-code/commit/92ea0c6dc3bf718c5a237e28db2d7e2c83978419), [`e42d4a5`](https://github.com/MoonshotAI/kimi-code/commit/e42d4a53b8b1fe73bbe5fde3ca142bfe4af3a5cf), [`1655099`](https://github.com/MoonshotAI/kimi-code/commit/16550990aa7ae3b526abcb2fb045868bebf5c418), [`314a6bd`](https://github.com/MoonshotAI/kimi-code/commit/314a6bd96baa697b41bc4b26dbcc74419af7ebde), [`3a43c68`](https://github.com/MoonshotAI/kimi-code/commit/3a43c683de31440e496b9b926a03db93c2baa16f), [`638fd94`](https://github.com/MoonshotAI/kimi-code/commit/638fd94b6c22589253570b9b90dbe5359849ddc2), [`13b09d9`](https://github.com/MoonshotAI/kimi-code/commit/13b09d994985d7747572730400be6ef89e722ab6), [`1ef139e`](https://github.com/MoonshotAI/kimi-code/commit/1ef139e6c32a01c7ac51a89fea6ae279c91bc276), [`2b1b095`](https://github.com/MoonshotAI/kimi-code/commit/2b1b095f3bbf48e83632b0aaaabce6773caf4469), [`1655099`](https://github.com/MoonshotAI/kimi-code/commit/16550990aa7ae3b526abcb2fb045868bebf5c418), [`f8375e1`](https://github.com/MoonshotAI/kimi-code/commit/f8375e18b74130ed82b7a314d10916e942c9f73b), [`ba2491c`](https://github.com/MoonshotAI/kimi-code/commit/ba2491ca4b86bd03ae691b36d34f3d7487468d68), [`a3de86a`](https://github.com/MoonshotAI/kimi-code/commit/a3de86aa53dcbf1a911d19932caf525bf0d4d0bc)]:
  - @moonshot-ai/agent-core-v2@0.7.0
  - @moonshot-ai/core@0.2.0
  - @moonshot-ai/kimi-code-product@0.0.4
  - @moonshot-ai/remote-control@0.0.4

## 0.3.3

### Patch Changes

- [#5212](https://github.com/MoonshotAI/kimi-code/pull/5212) [`2348f53`](https://github.com/MoonshotAI/kimi-code/commit/2348f531923616e250639bf66dcbf67c169ee4ab) Thanks [@kimi-agent-bot](https://github.com/kimi-agent-bot)! - Fix sessions that could not open after their model became unavailable.

- [#5300](https://github.com/MoonshotAI/kimi-code/pull/5300) [`fce3af9`](https://github.com/MoonshotAI/kimi-code/commit/fce3af9e694a5a572699546ebe8e28ccf004ed88) Thanks [@Grapedge](https://github.com/Grapedge)! - Add routes for feedback, reply ratings, and opt-in uploads of media, session history, and desktop logs. Servers advertise support in `capabilities.feedback`.

- Updated dependencies [[`f81c924`](https://github.com/MoonshotAI/kimi-code/commit/f81c924b1d70f963b0dc094bcb6859e446c37a49), [`fce3af9`](https://github.com/MoonshotAI/kimi-code/commit/fce3af9e694a5a572699546ebe8e28ccf004ed88), [`fce3af9`](https://github.com/MoonshotAI/kimi-code/commit/fce3af9e694a5a572699546ebe8e28ccf004ed88)]:
  - @moonshot-ai/agent-core-v2@0.6.1
  - @moonshot-ai/kimi-code-oauth@0.5.1

## 0.3.2

### Patch Changes

- [#5176](https://github.com/MoonshotAI/kimi-code/pull/5176) [`07e6120`](https://github.com/MoonshotAI/kimi-code/commit/07e61204e5c08509b7957f0c473c981d0eb6865e) Thanks [@wbxl2000](https://github.com/wbxl2000)! - `POST /api/v1/sessions/{session_id}:wait` replies that a session is settled only after the records it wrote so far are on disk, so a server that crashes right after the reply restarts with the same turns.

- Updated dependencies [[`7b20daf`](https://github.com/MoonshotAI/kimi-code/commit/7b20daf7ce8c734ad6150c5f56a9c107e0ecb44f), [`129b224`](https://github.com/MoonshotAI/kimi-code/commit/129b2247f53edd6172144e10d8c339156be96548)]:
  - @moonshot-ai/core@0.1.1

## 0.3.1

### Patch Changes

- [#5102](https://github.com/MoonshotAI/kimi-code/pull/5102) [`0b73b62`](https://github.com/MoonshotAI/kimi-code/commit/0b73b629dea1a8918813d2e3eb46bb597a5dad32) Thanks [@7Sageer](https://github.com/7Sageer)! - Limit SSH project discovery to five seconds per host when aggregating workspace and session lists.

## 0.3.0

### Minor Changes

- [#4457](https://github.com/MoonshotAI/kimi-code/pull/4457) [`e2ad1dc`](https://github.com/MoonshotAI/kimi-code/commit/e2ad1dcf214337ecfb5ca160fa36d5ef73560ab6) Thanks [@liruifengv](https://github.com/liruifengv)! - Allow file listings to expose symlinked directories and optionally follow symlinks outside the workspace.

### Patch Changes

- [#4527](https://github.com/MoonshotAI/kimi-code/pull/4527) [`1853dae`](https://github.com/MoonshotAI/kimi-code/commit/1853dae4ff54b36da878a08c86a7088bde0114a8) Thanks [@liruifengv](https://github.com/liruifengv)! - Add batched, folder-scoped Git and pull request queries for multi-root workspace panels.

- [#4525](https://github.com/MoonshotAI/kimi-code/pull/4525) [`8019337`](https://github.com/MoonshotAI/kimi-code/commit/80193374ebb47973a97d21d0b4ce4c27128eee82) Thanks [@liruifengv](https://github.com/liruifengv)! - Bind marketplace plugin installs to the displayed archive digest and declare catalog errors consistently.

- Updated dependencies [[`e2ad1dc`](https://github.com/MoonshotAI/kimi-code/commit/e2ad1dcf214337ecfb5ca160fa36d5ef73560ab6), [`1853dae`](https://github.com/MoonshotAI/kimi-code/commit/1853dae4ff54b36da878a08c86a7088bde0114a8), [`8019337`](https://github.com/MoonshotAI/kimi-code/commit/80193374ebb47973a97d21d0b4ce4c27128eee82)]:
  - @moonshot-ai/agent-core-v2@0.6.0
  - @moonshot-ai/kimi-code-product@0.0.3
  - @moonshot-ai/remote-control@0.0.3

## 0.2.5

### Patch Changes

- Updated dependencies [[`9f0693b`](https://github.com/MoonshotAI/kimi-code/commit/9f0693becb63a329cbf764325688448e76f40922)]:
  - @moonshot-ai/kimi-code-oauth@0.5.0
  - @moonshot-ai/agent-core-v2@0.5.1
  - @moonshot-ai/kimi-code-product@0.0.2
  - @moonshot-ai/remote-control@0.0.2

## 0.2.4

### Patch Changes

- Updated dependencies [[`5b93669`](https://github.com/MoonshotAI/kimi-code/commit/5b936697670ed15444bcb4720bd91e6ee776a941), [`5b93669`](https://github.com/MoonshotAI/kimi-code/commit/5b936697670ed15444bcb4720bd91e6ee776a941)]:
  - @moonshot-ai/agent-core-v2@0.5.0
  - @moonshot-ai/remote-control@0.0.1

## 0.2.3

### Patch Changes

- Updated dependencies [[`f143130`](https://github.com/MoonshotAI/kimi-code/commit/f143130c072e9dba8d60ef40c49d4305b93ab2fe)]:
  - @moonshot-ai/agent-core-v2@0.4.2
  - @moonshot-ai/transcript@0.0.2

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
