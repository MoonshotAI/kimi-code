# @moonshot-ai/kimi-code

## 0.29.0

### Minor Changes

- [#1992](https://github.com/MoonshotAI/kimi-code/pull/1992) [`a8f1ca3`](https://github.com/MoonshotAI/kimi-code/commit/a8f1ca3f1016a3e84986f297367e833bc731ac39) Thanks [@RealKai42](https://github.com/RealKai42)! - Support selecting a thinking effort level from ACP clients: the thinking picker now lists the current model's declared levels (for example off / low / medium / high) instead of only an on/off toggle. Use the thinking selector in your ACP client (e.g. Zed) to pick a level; the legacy on/off values keep working.

- [#1735](https://github.com/MoonshotAI/kimi-code/pull/1735) [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6) Thanks [@7Sageer](https://github.com/7Sageer)! - Let custom agent files restrict which sub-agent types they may delegate to (v2 engine only).

- [#1735](https://github.com/MoonshotAI/kimi-code/pull/1735) [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6) Thanks [@7Sageer](https://github.com/7Sageer)! - Support custom agents defined as Markdown files with frontmatter, usable as the main agent or a sub-agent (v2 engine only).

- [#1735](https://github.com/MoonshotAI/kimi-code/pull/1735) [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6) Thanks [@7Sageer](https://github.com/7Sageer)! - Add global tool gating to constrain which tools agents may use, with a per-session override (v2 engine only).

- [#2012](https://github.com/MoonshotAI/kimi-code/pull/2012) [`d67a200`](https://github.com/MoonshotAI/kimi-code/commit/d67a2003abf2d8d802dcf24f806e0a811724b83e) Thanks [@sailist](https://github.com/sailist)! - Add a GET /api/v1/fs:content server endpoint that serves any file on the host by absolute path as raw content with Content-Type, ETag, and Range support.

- [#1999](https://github.com/MoonshotAI/kimi-code/pull/1999) [`4c763f6`](https://github.com/MoonshotAI/kimi-code/commit/4c763f6763acb67a73d133f7450d092e71d63692) Thanks [@RealKai42](https://github.com/RealKai42)! - Videos attached to a prompt — pasted in the TUI or uploaded in the web UI — now reach the model together with the prompt, with no extra tool round trip, and stay playable in the chat after a reload.

- [#1735](https://github.com/MoonshotAI/kimi-code/pull/1735) [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6) Thanks [@7Sageer](https://github.com/7Sageer)! - Support overriding the default main-agent system prompt with a user-level file for every session (v2 engine only).

### Patch Changes

- [#1997](https://github.com/MoonshotAI/kimi-code/pull/1997) [`74da87a`](https://github.com/MoonshotAI/kimi-code/commit/74da87a457c2964694a844dd22a4925f5113b167) Thanks [@sailist](https://github.com/sailist)! - Add agent.created and agent.disposed events to the server session event stream, and expose each agent's disposal time in the transcript API.

- [#2030](https://github.com/MoonshotAI/kimi-code/pull/2030) [`ec88d35`](https://github.com/MoonshotAI/kimi-code/commit/ec88d352e8f4dc5e8ffd1212f016138458f69893) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix catalog-imported Claude models being wrongly locked into always-on thinking, and stop offering a misleading thinking Off option for models that cannot truly disable reasoning (such as Gemini 3). Also normalizes configured thinking effort values and unifies context-usage reporting.

- [#2015](https://github.com/MoonshotAI/kimi-code/pull/2015) [`b5efba7`](https://github.com/MoonshotAI/kimi-code/commit/b5efba7abcaf4041f81ec520097a61e6546e8c50) Thanks [@RealKai42](https://github.com/RealKai42)! - Import many more providers from the models.dev catalog: vendor SDKs like xai and openrouter now import instead of being refused (with a "guessed" note), deprecated and alpha models are filtered out, per-model gateway protocol and endpoint overrides are honored, and context limits are correct (input limit for compaction, total window for completion). Imports lacking a usable endpoint now ask for one via `--base-url` or a prompt.

- [#1993](https://github.com/MoonshotAI/kimi-code/pull/1993) [`37eda4e`](https://github.com/MoonshotAI/kimi-code/commit/37eda4e59aebc8ecafa91be3f43f971ed63963a3) Thanks [@RealKai42](https://github.com/RealKai42)! - Add environment variable overrides for agent loop and background task limits. Set KIMI_LOOP_MAX_STEPS_PER_TURN, KIMI_LOOP_MAX_RETRIES_PER_STEP, or KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS to take priority over the [loop_control] and [background] config.

- [#1993](https://github.com/MoonshotAI/kimi-code/pull/1993) [`37eda4e`](https://github.com/MoonshotAI/kimi-code/commit/37eda4e59aebc8ecafa91be3f43f971ed63963a3) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix config environment overrides (such as KIMI_IMAGE_MAX_EDGE_PX or KIMI_SUBAGENT_TIMEOUT_MS) being persisted into config.toml by config API writes while the env var is set, and keeping the old value after the env var is changed to an invalid value or removed.

- [#2050](https://github.com/MoonshotAI/kimi-code/pull/2050) [`8250e59`](https://github.com/MoonshotAI/kimi-code/commit/8250e590f3ed5990c233ef5a2c7666468f0bcb05) Thanks [@sailist](https://github.com/sailist)! - Remove references to the non-existent `kimi resume` command from the scheduled-task tool descriptions.

- [#1970](https://github.com/MoonshotAI/kimi-code/pull/1970) [`6dd4fd3`](https://github.com/MoonshotAI/kimi-code/commit/6dd4fd33688b37904d5302436fc2daaf09d66c7d) Thanks [@sailist](https://github.com/sailist)! - Fix cancelled model requests being wrapped as retryable provider errors, so interrupting a request no longer triggers silent retries.

- [#1970](https://github.com/MoonshotAI/kimi-code/pull/1970) [`6dd4fd3`](https://github.com/MoonshotAI/kimi-code/commit/6dd4fd33688b37904d5302436fc2daaf09d66c7d) Thanks [@sailist](https://github.com/sailist)! - Send the session prompt cache key to OpenAI and OpenAI Responses providers, restoring provider-side prompt cache affinity that previously only reached Kimi and Anthropic.

- [#1999](https://github.com/MoonshotAI/kimi-code/pull/1999) [`4c763f6`](https://github.com/MoonshotAI/kimi-code/commit/4c763f6763acb67a73d133f7450d092e71d63692) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix ReadMediaFile failing on videos when the provider has no file upload channel — such videos now fall back to inline delivery.

- [#1968](https://github.com/MoonshotAI/kimi-code/pull/1968) [`71bcfba`](https://github.com/MoonshotAI/kimi-code/commit/71bcfba54a6836f4b6d4e26babde67576b293a64) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix sessions getting stuck on every turn with a provider "message must not be empty" error after a content-filtered response.

- [#2022](https://github.com/MoonshotAI/kimi-code/pull/2022) [`154e082`](https://github.com/MoonshotAI/kimi-code/commit/154e0824880c8573433e4ec7ada083744dbfe9f9) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Show transparent images over a checkerboard canvas so white and black content stays visible in both light and dark themes.

- [#1990](https://github.com/MoonshotAI/kimi-code/pull/1990) [`115b096`](https://github.com/MoonshotAI/kimi-code/commit/115b0968cefede7fac1494c6f0154ea5545a89da) Thanks [@liruifengv](https://github.com/liruifengv)! - Fix goal mode continuation prompts leaking into the transcript when resuming a session.

- [#1970](https://github.com/MoonshotAI/kimi-code/pull/1970) [`6dd4fd3`](https://github.com/MoonshotAI/kimi-code/commit/6dd4fd33688b37904d5302436fc2daaf09d66c7d) Thanks [@sailist](https://github.com/sailist)! - Rework the model wire layer in the experimental v2 engine into a small set of protocol bases plus declarative provider trait definitions, so adding a provider no longer means copying adapter code, and per-turn request intent (cache key, thinking effort, sampling) flows as request parameters instead of cloned model objects. The never-functional `[platforms]` config section and the `provider.platformId` field are removed; credential resolution is now a two-layer model → provider lookup.

- [#1976](https://github.com/MoonshotAI/kimi-code/pull/1976) [`e458323`](https://github.com/MoonshotAI/kimi-code/commit/e45832398d0d9cad98dbad1cbf1e5b103a20aace) Thanks [@liruifengv](https://github.com/liruifengv)! - Improve TUI performance and resume speed for long-running sessions.

- [#1991](https://github.com/MoonshotAI/kimi-code/pull/1991) [`92576e4`](https://github.com/MoonshotAI/kimi-code/commit/92576e4d850ada51a24e72fe76a83cc512df922a) Thanks [@7Sageer](https://github.com/7Sageer)! - Reconnect a dropped MCP server connection automatically when one of its tools is called, and retry the call once.

- [#1970](https://github.com/MoonshotAI/kimi-code/pull/1970) [`6dd4fd3`](https://github.com/MoonshotAI/kimi-code/commit/6dd4fd33688b37904d5302436fc2daaf09d66c7d) Thanks [@sailist](https://github.com/sailist)! - Add read-only model resolution inspection and a live connectivity probe to the server's RPC surface, reporting per-field value provenance (config, override, builtin, env, synthesized) for internal debugging tools.

- [#2015](https://github.com/MoonshotAI/kimi-code/pull/2015) [`b5efba7`](https://github.com/MoonshotAI/kimi-code/commit/b5efba7abcaf4041f81ec520097a61e6546e8c50) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix thinking levels being offered for models that do not support them (e.g. phantom levels on Kimi K3): levels now come from each model's declared capabilities. Models that cannot disable reasoning (e.g. gpt-5) no longer offer an Off option, and turning thinking Off on models that support it (e.g. xai grok) now truly disables reasoning.

- [#1735](https://github.com/MoonshotAI/kimi-code/pull/1735) [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6) Thanks [@7Sageer](https://github.com/7Sageer)! - Warn when a tool allow/deny list entry can never match any tool, for example a misspelled name (v2 engine only).

- [#2005](https://github.com/MoonshotAI/kimi-code/pull/2005) [`a3699dd`](https://github.com/MoonshotAI/kimi-code/commit/a3699dd6aa7b41efd3129a117007d195282379fd) Thanks [@7Sageer](https://github.com/7Sageer)! - Add an `active` flag to each tool in the server's tool listing API.

- [#1995](https://github.com/MoonshotAI/kimi-code/pull/1995) [`73eb5f8`](https://github.com/MoonshotAI/kimi-code/commit/73eb5f89e06fb15d42c7585a147eb1c5caef0725) Thanks [@liruifengv](https://github.com/liruifengv)! - Remove red coloring from syntax highlighting in code previews and markdown code blocks.

- [#2014](https://github.com/MoonshotAI/kimi-code/pull/2014) [`576d650`](https://github.com/MoonshotAI/kimi-code/commit/576d65038035570bea90b58d5824bcd60ca11258) Thanks [@liruifengv](https://github.com/liruifengv)! - Add a reminder for third-party install sources to use the official installer in the update prompt.

## 0.28.1

### Patch Changes

- [#934](https://github.com/MoonshotAI/kimi-code/pull/934) [`c5b6103`](https://github.com/MoonshotAI/kimi-code/commit/c5b6103bb9b0a163d48cbce0034c3fc7dea7c344) Thanks [@tt-a1i](https://github.com/tt-a1i)! - Allow ACP sessions to start with configured non-OAuth model credentials instead of requiring terminal login.

- [#1967](https://github.com/MoonshotAI/kimi-code/pull/1967) [`ad8cc85`](https://github.com/MoonshotAI/kimi-code/commit/ad8cc8525198a08bc1181cee9a15bbb4521cd9bc) Thanks [@sailist](https://github.com/sailist)! - Run web servers foreground-only end to end: the /web slash command now always starts a new server, and the `kimi web kill` / `kimi web ps` subcommands are removed — foreground servers stop with Ctrl+C. `kimi server kill` remains as a deprecated fallback that only stops servers started by a version before 0.28.0.

- [#1948](https://github.com/MoonshotAI/kimi-code/pull/1948) [`f6f4192`](https://github.com/MoonshotAI/kimi-code/commit/f6f4192957ace3f0cceb734a04b3b26b1d2f88be) Thanks [@sailist](https://github.com/sailist)! - Fix running subagents not observing permission mode switches made after they started.

## 0.28.0

### Minor Changes

- [#1826](https://github.com/MoonshotAI/kimi-code/pull/1826) [`a41a09c`](https://github.com/MoonshotAI/kimi-code/commit/a41a09c33c8e432fbc306f5882692c967ed5ea17) Thanks [@sailist](https://github.com/sailist)! - Replace the `kimi server` command tree with `kimi web`: the server runs in the foreground (the background daemon and OS-service lifecycle commands are removed), and multiple servers can now share one home directory, each taking the next free port. Manage instances with `kimi web kill [server-id|all]`, `kimi web ps`, and `kimi web rotate-token`; any `kimi server …` invocation prints a deprecation notice and exits 1.

- [#1933](https://github.com/MoonshotAI/kimi-code/pull/1933) [`11c1683`](https://github.com/MoonshotAI/kimi-code/commit/11c1683a1cd2adab276562419d2d353629063d80) Thanks [@liruifengv](https://github.com/liruifengv)! - Thinking effort persists only levels below the model's top tier (max).

### Patch Changes

- [#1867](https://github.com/MoonshotAI/kimi-code/pull/1867) [`3086e47`](https://github.com/MoonshotAI/kimi-code/commit/3086e4703992fbbe7a41379405ee243713ad9ced) Thanks [@RealKai42](https://github.com/RealKai42)! - Rename the stale "afk" reference to "auto" in the built-in MCP config skill guidance.

- [#1867](https://github.com/MoonshotAI/kimi-code/pull/1867) [`3086e47`](https://github.com/MoonshotAI/kimi-code/commit/3086e4703992fbbe7a41379405ee243713ad9ced) Thanks [@RealKai42](https://github.com/RealKai42)! - Correct the YOLO and Auto permission mode descriptions in CLI --help output and in the ACP session mode selector shown by IDE clients.

- [#1867](https://github.com/MoonshotAI/kimi-code/pull/1867) [`3086e47`](https://github.com/MoonshotAI/kimi-code/commit/3086e4703992fbbe7a41379405ee243713ad9ced) Thanks [@RealKai42](https://github.com/RealKai42)! - web: Correct the YOLO and Auto permission mode descriptions in the slash command list and the mobile permission sheet.

- [#1867](https://github.com/MoonshotAI/kimi-code/pull/1867) [`3086e47`](https://github.com/MoonshotAI/kimi-code/commit/3086e4703992fbbe7a41379405ee243713ad9ced) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix the YOLO and Auto permission mode descriptions to match their actual behavior: YOLO auto-approves tool actions but the agent may still ask questions, while Auto is fully autonomous and never asks.

- [#1867](https://github.com/MoonshotAI/kimi-code/pull/1867) [`3086e47`](https://github.com/MoonshotAI/kimi-code/commit/3086e4703992fbbe7a41379405ee243713ad9ced) Thanks [@RealKai42](https://github.com/RealKai42)! - Correct the YOLO mode notice shown when replaying a session: tool actions are auto-approved, but the agent may still ask questions.

- [#1843](https://github.com/MoonshotAI/kimi-code/pull/1843) [`a3e773f`](https://github.com/MoonshotAI/kimi-code/commit/a3e773f90ce66abe6db229607440c20769537c93) Thanks [@7Sageer](https://github.com/7Sageer)! - Fix the web backend ignoring symbolic links when loading AGENTS.md files and reading files.

- [#1940](https://github.com/MoonshotAI/kimi-code/pull/1940) [`d71bf9e`](https://github.com/MoonshotAI/kimi-code/commit/d71bf9e5a56b5978316e715f7c131c784967d562) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Add a note in the model switcher that switching models or thinking effort invalidates the existing prompt cache.

## 0.27.0

### Minor Changes

- [#1822](https://github.com/MoonshotAI/kimi-code/pull/1822) [`a5c568d`](https://github.com/MoonshotAI/kimi-code/commit/a5c568dc7a84962bae70a16858709c453fc90a07) Thanks [@liruifengv](https://github.com/liruifengv)! - Add the /copy slash command to copy the last assistant message to the clipboard.

- [#1824](https://github.com/MoonshotAI/kimi-code/pull/1824) [`bfecd01`](https://github.com/MoonshotAI/kimi-code/commit/bfecd0128fe7d88971a84095e24ef8a56ba34e71) Thanks [@liruifengv](https://github.com/liruifengv)! - Using an API key for Kimi coding models now also fetches the latest model list automatically.

### Patch Changes

- [#1811](https://github.com/MoonshotAI/kimi-code/pull/1811) [`cec15e2`](https://github.com/MoonshotAI/kimi-code/commit/cec15e2188b24e0f904e5ca660a2e72c06364647) Thanks [@liruifengv](https://github.com/liruifengv)! - Fix Esc and Ctrl+C cancelling compaction instead of closing an open /btw panel.

- [#1806](https://github.com/MoonshotAI/kimi-code/pull/1806) [`9b49694`](https://github.com/MoonshotAI/kimi-code/commit/9b496946dcb3c7fa9507e6d5c251c1941e44a316) Thanks [@sailist](https://github.com/sailist)! - Mount the dev-only /api/v1/debug RPC surface behind the --debug-endpoints flag, exposing every scoped service for local debugging on loopback binds. Pass --debug-endpoints to kimi server run to enable it.

- [#1788](https://github.com/MoonshotAI/kimi-code/pull/1788) [`365ba00`](https://github.com/MoonshotAI/kimi-code/commit/365ba0001de206863ff1de8e106c85d7f187c192) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix `/export-debug-zip` and `kimi export` overwriting the previous ZIP archive when run repeatedly on the same session; the default export filename now includes a timestamp.

- [#1840](https://github.com/MoonshotAI/kimi-code/pull/1840) [`fa7e4ba`](https://github.com/MoonshotAI/kimi-code/commit/fa7e4ba4218703bb1ef3112ab2493496983b0539) Thanks [@7Sageer](https://github.com/7Sageer)! - Fix AGENTS.md files installed as symbolic links being ignored by the web backend.

- [#1829](https://github.com/MoonshotAI/kimi-code/pull/1829) [`1b907b0`](https://github.com/MoonshotAI/kimi-code/commit/1b907b07cdcc0e9cba5203fe40dacae85a4b768d) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix whitespace-only thinking content rendering as a blank bullet line in the transcript, both while streaming and when replaying session history.

- [#1809](https://github.com/MoonshotAI/kimi-code/pull/1809) [`56a321d`](https://github.com/MoonshotAI/kimi-code/commit/56a321d4d127c0b4cf7a3e15e2959ebf3eded192) Thanks [@sailist](https://github.com/sailist)! - web: Fix duplicate workspace groups on Windows when the same folder is opened with different path spellings, such as a different drive-letter casing; all of the folder's sessions now list under the single merged group.

- [#1847](https://github.com/MoonshotAI/kimi-code/pull/1847) [`56ba8e0`](https://github.com/MoonshotAI/kimi-code/commit/56ba8e0196a3053ad1115a7e8f8b8c4c0cd1b320) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Fix LaTeX formulas rendering as garbled overlapping text when the web UI is accessed over the network; the server's content security policy now allows the inline styles that math and code highlighting rely on, while scripts remain strictly restricted.

- [#1816](https://github.com/MoonshotAI/kimi-code/pull/1816) [`44f3341`](https://github.com/MoonshotAI/kimi-code/commit/44f334191989183d21920f6867c405581347c748) Thanks [@sailist](https://github.com/sailist)! - Harden the embedded key-value engine's durability: WAL compaction now always terminates under sustained write storms instead of chasing the tail forever, a committed write can no longer slip through a compaction rotation undetected, torn WAL tails no longer misplace later disk-mode value pointers, read-only opens never create or modify database files or compact under a live writer, corrupt index-definition files no longer force a full rebuild, stale compaction temp files are cleaned on open, and the process lock can no longer be taken over by several processes at once.

- [#1816](https://github.com/MoonshotAI/kimi-code/pull/1816) [`44f3341`](https://github.com/MoonshotAI/kimi-code/commit/44f334191989183d21920f6867c405581347c748) Thanks [@sailist](https://github.com/sailist)! - Speed up the embedded key-value engine under stress: queries with skip/limit now stream candidates instead of decoding every match first, LRU eviction picks victims in O(1) instead of scanning every key, bursts of simultaneously expired TTL keys are drained within seconds, existence checks and size counting no longer read values when they only need metadata, and one oversized token can no longer poison the full-text index.

- [#1816](https://github.com/MoonshotAI/kimi-code/pull/1816) [`44f3341`](https://github.com/MoonshotAI/kimi-code/commit/44f334191989183d21920f6867c405581347c748) Thanks [@sailist](https://github.com/sailist)! - Cluster readers of the embedded key-value engine now catch up incrementally by replaying only newly appended WAL frames after another process writes, instead of fully reopening the shard on every read; cross-process read latency drops by orders of magnitude at larger shard sizes, and readers still fall back to a full reopen after WAL rotation or truncation.

- [#1816](https://github.com/MoonshotAI/kimi-code/pull/1816) [`44f3341`](https://github.com/MoonshotAI/kimi-code/commit/44f334191989183d21920f6867c405581347c748) Thanks [@sailist](https://github.com/sailist)! - Keep the embedded key-value engine writable when a WAL compaction rotation fails mid-way instead of wedging it until reopen, stop a rolled-back write from erasing a concurrently committed value for the same key, let the RESP server survive aborted connections, recover after oversized requests, and answer each pipelined command independently, and keep the previous full-text index intact when a postings rebuild fails.

- [#1808](https://github.com/MoonshotAI/kimi-code/pull/1808) [`b53e00d`](https://github.com/MoonshotAI/kimi-code/commit/b53e00db91872efc602743d07d2283f7938eaea2) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Include the underlying network cause (DNS failure, refused connection, TLS or timeout errors) in OAuth connection error messages instead of a bare "fetch failed".

- [#1790](https://github.com/MoonshotAI/kimi-code/pull/1790) [`373abb0`](https://github.com/MoonshotAI/kimi-code/commit/373abb02f03ef817e2e1937e1cdc4423ef0cd149) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix repeated request rejections after an interrupted model response by recording tool calls that never ran and closing them with an interrupted result.

- [#1791](https://github.com/MoonshotAI/kimi-code/pull/1791) [`3144972`](https://github.com/MoonshotAI/kimi-code/commit/31449728b72df94e22bcb2de350a1e7624895e30) Thanks [@sailist](https://github.com/sailist)! - Fix the built-in URL fetch tool's network safeguards: crafted domains and redirect chains can no longer reach loopback or internal network services.

- [#1787](https://github.com/MoonshotAI/kimi-code/pull/1787) [`319001a`](https://github.com/MoonshotAI/kimi-code/commit/319001ae5cde6df383579214a126564b9ed2b114) Thanks [@sailist](https://github.com/sailist)! - web: Remove per-workspace git repo badges and branch labels; branch, PR, and diff status remain shown for the active session.

- [#1838](https://github.com/MoonshotAI/kimi-code/pull/1838) [`9e12484`](https://github.com/MoonshotAI/kimi-code/commit/9e1248416faa22d9f0b777b91ad092bbf1e19182) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Remember the thinking level per model, fixing an empty and unresponsive thinking picker when the active model does not support a previously stored level.

- [#1833](https://github.com/MoonshotAI/kimi-code/pull/1833) [`03021b6`](https://github.com/MoonshotAI/kimi-code/commit/03021b6db7166c750dd34043edaa85c423d3202f) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Fix queued messages silently re-sending previously uploaded files when a session is reopened.

## 0.26.0

### Minor Changes

- [#1776](https://github.com/MoonshotAI/kimi-code/pull/1776) [`ffaf0b9`](https://github.com/MoonshotAI/kimi-code/commit/ffaf0b98ca76bb90ba9c989256441dceb468d85f) Thanks [@sailist](https://github.com/sailist)! - Expand the coder subagent tool set to include background tasks, todo lists, plan mode, skill invocation, and nested agents, mirroring the main agent's capabilities; a subagent run also waits for its background tasks to settle before reporting completion. Applies automatically to coder subagents launched through the Agent tool.

### Patch Changes

- [#1771](https://github.com/MoonshotAI/kimi-code/pull/1771) [`b513975`](https://github.com/MoonshotAI/kimi-code/commit/b5139757e2df1b5b8723d4bab5137266f5eb0f01) Thanks [@liruifengv](https://github.com/liruifengv)! - Optimize the unit formatting of the context usage display.

- [#1765](https://github.com/MoonshotAI/kimi-code/pull/1765) [`d531398`](https://github.com/MoonshotAI/kimi-code/commit/d531398d0143cd3b0a2f4a099ff537894c9245e9) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix Kimi-provider models routed through the Anthropic protocol incorrectly showing reasoning effort options. Effort choices now come only from the model's declared metadata, and the inferred fallback profile applies solely to non-Kimi Anthropic-compatible providers.

- [#1774](https://github.com/MoonshotAI/kimi-code/pull/1774) [`3d5d630`](https://github.com/MoonshotAI/kimi-code/commit/3d5d630c12ea71fb7066e8018dfa2cb6d42da3e8) Thanks [@RealKai42](https://github.com/RealKai42)! - Honor an explicit thinking "off" on OpenAI-compatible (chat completions) providers: it used to be indistinguishable from "never configured", so the history-based auto `reasoning_effort` injection kept the model reasoning (and could leak the field to models that reject it). The provider now also reports the actual current thinking effort ("on"/"off") instead of recording "off" for both.

- [#1766](https://github.com/MoonshotAI/kimi-code/pull/1766) [`7042af3`](https://github.com/MoonshotAI/kimi-code/commit/7042af3571dbfbf5600535a56692434b84afb4ce) Thanks [@kermanx](https://github.com/kermanx)! - web: Fix the sidebar resize handle being covered by the chat composer background.

- [#1769](https://github.com/MoonshotAI/kimi-code/pull/1769) [`d1ca65e`](https://github.com/MoonshotAI/kimi-code/commit/d1ca65e1de189617e9edbc54010e62d472a1de3d) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Keep legacy migrations idempotent across multiple Kimi homes and report damaged or unmapped sessions instead of silently skipping them.

- [#1763](https://github.com/MoonshotAI/kimi-code/pull/1763) [`81414b6`](https://github.com/MoonshotAI/kimi-code/commit/81414b6ad5eddb64bbd959a8754ffb6c20b4f6fe) Thanks [@liruifengv](https://github.com/liruifengv)! - Warn in the /model and /effort pickers that switching invalidates the existing prompt cache, and hint to use /new to avoid extra token costs.

- [#1773](https://github.com/MoonshotAI/kimi-code/pull/1773) [`1169a6d`](https://github.com/MoonshotAI/kimi-code/commit/1169a6d5fdafca4c1455c3ac4889586ef42f4435) Thanks [@RealKai42](https://github.com/RealKai42)! - Replay empty thinking content verbatim instead of substituting a placeholder space on Anthropic-compatible and Kimi preserved-thinking endpoints.

- [#1781](https://github.com/MoonshotAI/kimi-code/pull/1781) [`09e8554`](https://github.com/MoonshotAI/kimi-code/commit/09e855401be62431b967dcb3b7caf1bcc9705df5) Thanks [@kermanx](https://github.com/kermanx)! - Report when users stop tasks and preserve other stop reasons in model context.

- [#1784](https://github.com/MoonshotAI/kimi-code/pull/1784) [`d465591`](https://github.com/MoonshotAI/kimi-code/commit/d465591eb3fdb30c0c0348d6edb6f4d3d2f72698) Thanks [@sailist](https://github.com/sailist)! - Fix a resumed session being marked as just updated and jumping to the top of the session list without any new activity.

- [#1759](https://github.com/MoonshotAI/kimi-code/pull/1759) [`9e3e670`](https://github.com/MoonshotAI/kimi-code/commit/9e3e6700f9276f4ab60219897b297fc96be2355a) Thanks [@sailist](https://github.com/sailist)! - Fix a race where resuming a background subagent right after it was manually stopped could fail with an "already running" error.

- [#1782](https://github.com/MoonshotAI/kimi-code/pull/1782) [`072eed4`](https://github.com/MoonshotAI/kimi-code/commit/072eed476b5fe7599d994783649a21083320df58) Thanks [@sailist](https://github.com/sailist)! - Fix the context size indicator under-reporting the model's actual context usage.

- [#1769](https://github.com/MoonshotAI/kimi-code/pull/1769) [`d1ca65e`](https://github.com/MoonshotAI/kimi-code/commit/d1ca65e1de189617e9edbc54010e62d472a1de3d) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Support in-process editor hosts with session lifecycle, context, MCP configuration, and cross-platform session storage APIs.

- [#1772](https://github.com/MoonshotAI/kimi-code/pull/1772) [`78967e2`](https://github.com/MoonshotAI/kimi-code/commit/78967e283d28238337e6437b4824f67b2c3cea7d) Thanks [@sailist](https://github.com/sailist)! - web: Refresh the model catalog for all providers when opening the model picker, so newly available models always show up.

## 0.25.0

### Minor Changes

- [#1731](https://github.com/MoonshotAI/kimi-code/pull/1731) [`0b790cd`](https://github.com/MoonshotAI/kimi-code/commit/0b790cdc056475593abd572f657d010504caf752) Thanks [@sailist](https://github.com/sailist)! - web: Allow attaching any file type in chat; files the model cannot consume inline (documents, SVG images, archives, …) are uploaded to the server and given to the model as a file path it can read on demand.

### Patch Changes

- [#1746](https://github.com/MoonshotAI/kimi-code/pull/1746) [`918c135`](https://github.com/MoonshotAI/kimi-code/commit/918c1354d9ff4a7dc66a02ede3a504d19e1f53d1) Thanks [@RealKai42](https://github.com/RealKai42)! - Honor adaptive_thinking = false on Anthropic-compatible models by limiting thinking efforts to the legacy budget set and omitting the effort parameter from requests.

- [#1746](https://github.com/MoonshotAI/kimi-code/pull/1746) [`918c135`](https://github.com/MoonshotAI/kimi-code/commit/918c1354d9ff4a7dc66a02ede3a504d19e1f53d1) Thanks [@RealKai42](https://github.com/RealKai42)! - Apply official Anthropic effort profiles and a 128k output fallback for unknown models. Preserve compatible-provider thinking history across session resumes and model switches, normalize incomplete stream events, and warn on unlisted efforts.

- [#1746](https://github.com/MoonshotAI/kimi-code/pull/1746) [`918c135`](https://github.com/MoonshotAI/kimi-code/commit/918c1354d9ff4a7dc66a02ede3a504d19e1f53d1) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix custom-named models on Anthropic-compatible providers starting new sessions with thinking effort off instead of the model default, and not showing the thinking control in ACP clients.

- [#1757](https://github.com/MoonshotAI/kimi-code/pull/1757) [`f0c8a10`](https://github.com/MoonshotAI/kimi-code/commit/f0c8a103c620b4a66761c0f34c1a8cc7ece9b86c) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix the diagnostic log missing the actual error when the CLI exits unexpectedly.

- [#1731](https://github.com/MoonshotAI/kimi-code/pull/1731) [`0b790cd`](https://github.com/MoonshotAI/kimi-code/commit/0b790cdc056475593abd572f657d010504caf752) Thanks [@sailist](https://github.com/sailist)! - Fix the Content-Security-Policy on non-loopback server binds blocking the web UI's theme bootstrap script and bundled fonts, and tighten the policy with explicit form-action, base-uri, and frame-ancestors directives.

- [#1758](https://github.com/MoonshotAI/kimi-code/pull/1758) [`1d7c205`](https://github.com/MoonshotAI/kimi-code/commit/1d7c205e8397983d3d79e59704db3f67a0c72937) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix the CLI exiting unexpectedly when reading an image from the clipboard fails; it now falls back to pasting text.

- [#1753](https://github.com/MoonshotAI/kimi-code/pull/1753) [`d8ddabb`](https://github.com/MoonshotAI/kimi-code/commit/d8ddabb605c1f6fdcfa9fade8cc09b5f8c93651f) Thanks [@sailist](https://github.com/sailist)! - Fix the web server bearer-token check being bypassed by percent-encoded API paths (e.g. `/%61pi/v1/…`), which allowed unauthenticated access to every API route.

- [#1758](https://github.com/MoonshotAI/kimi-code/pull/1758) [`1d7c205`](https://github.com/MoonshotAI/kimi-code/commit/1d7c205e8397983d3d79e59704db3f67a0c72937) Thanks [@RealKai42](https://github.com/RealKai42)! - Report crash telemetry for unhandled promise rejections, so exits they cause are no longer invisible.

- [#1753](https://github.com/MoonshotAI/kimi-code/pull/1753) [`d8ddabb`](https://github.com/MoonshotAI/kimi-code/commit/d8ddabb605c1f6fdcfa9fade8cc09b5f8c93651f) Thanks [@sailist](https://github.com/sailist)! - Fix the session filesystem API following symlinks that point outside the workspace, which allowed reading, listing, creating, and downloading host files beyond the session directory through a planted symlink.

- [#1753](https://github.com/MoonshotAI/kimi-code/pull/1753) [`d8ddabb`](https://github.com/MoonshotAI/kimi-code/commit/d8ddabb605c1f6fdcfa9fade8cc09b5f8c93651f) Thanks [@sailist](https://github.com/sailist)! - Fix sessions failing to be created when the workspace directory is given through a symlink, which the v2 engine rejected as "not a directory".

- [#1754](https://github.com/MoonshotAI/kimi-code/pull/1754) [`1186686`](https://github.com/MoonshotAI/kimi-code/commit/11866865544b8ec88330372b8582e97a35113308) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Fix completed background subagents losing their final output after a session reload, and retry the output backfill when a transient fetch failure occurs.

- [#1755](https://github.com/MoonshotAI/kimi-code/pull/1755) [`4f99114`](https://github.com/MoonshotAI/kimi-code/commit/4f99114342da11ebf7a403e3af6e0cf2c8cca431) Thanks [@kermanx](https://github.com/kermanx)! - Move the server's v1 wire schema definitions into the engine domains and the server package, removing the shared schema package from the v2 server stack with no behavior change.

- [#1731](https://github.com/MoonshotAI/kimi-code/pull/1731) [`0b790cd`](https://github.com/MoonshotAI/kimi-code/commit/0b790cdc056475593abd572f657d010504caf752) Thanks [@sailist](https://github.com/sailist)! - web: Show every attachment a user sends — files, images, and videos — as chips in the message bubble, and let files be attached by dropping them anywhere in the window.

- [#1744](https://github.com/MoonshotAI/kimi-code/pull/1744) [`b89d385`](https://github.com/MoonshotAI/kimi-code/commit/b89d385fa56915f067d656160086bc3c3126f8a3) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Fix Enter not confirming modal confirmation dialogs in dev builds, and keep the dialog open with a loading state until the confirmed action (such as archiving a session) completes.

- [#1756](https://github.com/MoonshotAI/kimi-code/pull/1756) [`e885aec`](https://github.com/MoonshotAI/kimi-code/commit/e885aec7ffa9ee62d122908b68837c5e010d5d04) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Show full diagnostics for model request failures — a semantic title, the provider's raw message, and expandable details (error code, HTTP status, request ID) with copy support — instead of a bare "Connection error" toast.

- [#1751](https://github.com/MoonshotAI/kimi-code/pull/1751) [`df75a0f`](https://github.com/MoonshotAI/kimi-code/commit/df75a0f5c2f2e2dd3291c8adaba96a832ee1f179) Thanks [@kermanx](https://github.com/kermanx)! - web: Keep session activity indicators in sync with agent work, prevent duplicate streamed content after session activation races or LLM retries, and flush durable session events promptly.

- [#1754](https://github.com/MoonshotAI/kimi-code/pull/1754) [`1186686`](https://github.com/MoonshotAI/kimi-code/commit/11866865544b8ec88330372b8582e97a35113308) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Fix a background subagent showing up as two identical rows in the agents dock panel during streaming.

## 0.24.2

### Patch Changes

- [#1704](https://github.com/MoonshotAI/kimi-code/pull/1704) [`38a2363`](https://github.com/MoonshotAI/kimi-code/commit/38a2363a006d8ed32ff6100ccff2dc7d1a70b2b0) Thanks [@sailist](https://github.com/sailist)! - Align the print-mode run lifecycle across engines: `print_background_mode` and `print_max_turns` now take effect for `kimi -p` on the experimental engine, with the same exit / drain / steer semantics and defaults as the default engine, and `kimi -p "/goal ..."` now stays alive until the goal reaches a terminal state instead of exiting after the first turn.

- [#1704](https://github.com/MoonshotAI/kimi-code/pull/1704) [`38a2363`](https://github.com/MoonshotAI/kimi-code/commit/38a2363a006d8ed32ff6100ccff2dc7d1a70b2b0) Thanks [@sailist](https://github.com/sailist)! - Align the subagent timeout across engines: a fixed 2-hour default, overridable with `[subagent] timeout_ms` in config.toml or the KIMI_SUBAGENT_TIMEOUT_MS environment variable.

- [#1727](https://github.com/MoonshotAI/kimi-code/pull/1727) [`286d3e7`](https://github.com/MoonshotAI/kimi-code/commit/286d3e7aca40a778cc4136eb377e14f14c70141c) Thanks [@liruifengv](https://github.com/liruifengv)! - Add a builtin `check-kimi-code-docs` skill that answers Kimi Code product questions (CLI usage, configuration, membership, error codes) against the official documentation with source links. It triggers automatically on product questions, or run `/check-kimi-code-docs`.

- [#1707](https://github.com/MoonshotAI/kimi-code/pull/1707) [`8490c3e`](https://github.com/MoonshotAI/kimi-code/commit/8490c3e36b6a6cc3ba5c0f15d93b87347ce23878) Thanks [@sailist](https://github.com/sailist)! - Add the number of messages dropped during compaction retries to the session wire log's LLM request traces.

- [#1740](https://github.com/MoonshotAI/kimi-code/pull/1740) [`a74ab44`](https://github.com/MoonshotAI/kimi-code/commit/a74ab44ac7d5656e2dd9cf93b8e484936b05a0c8) Thanks [@sailist](https://github.com/sailist)! - Increase the default per-step LLM retry budget from 3 to 10 attempts, so transient provider failures (429 / overload) are retried with exponential backoff for a few minutes before the turn fails. Tune with `loop_control.max_retries_per_step` in config.toml.

- [#1707](https://github.com/MoonshotAI/kimi-code/pull/1707) [`8490c3e`](https://github.com/MoonshotAI/kimi-code/commit/8490c3e36b6a6cc3ba5c0f15d93b87347ce23878) Thanks [@sailist](https://github.com/sailist)! - Rename the dynamic tool loading model capability from `select_tools` to `dynamically_loaded_tools`, matching the model catalog vocabulary; the `select_tools` tool and the `tool-select` flag are unchanged.

- [#1698](https://github.com/MoonshotAI/kimi-code/pull/1698) [`722694a`](https://github.com/MoonshotAI/kimi-code/commit/722694adf99c53dc608d417ea6d8c90a5712c33f) Thanks [@chengluyu](https://github.com/chengluyu)! - Enforce goal wall-clock budgets while model or tool work is still running.

- [#1730](https://github.com/MoonshotAI/kimi-code/pull/1730) [`72f425e`](https://github.com/MoonshotAI/kimi-code/commit/72f425e18d0264010e1442af67ee8d9acf5f0659) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Fix tool call id collisions across turns for Gemini-protocol models, which merged separate swarm runs into a single card in the web UI.

- [#1695](https://github.com/MoonshotAI/kimi-code/pull/1695) [`5c0f17c`](https://github.com/MoonshotAI/kimi-code/commit/5c0f17cfcf99c27eb697be11ae9b61243d993e4a) Thanks [@chengluyu](https://github.com/chengluyu)! - Preserve active goal elapsed time across crash recovery.

- [#1743](https://github.com/MoonshotAI/kimi-code/pull/1743) [`481b28b`](https://github.com/MoonshotAI/kimi-code/commit/481b28b8f4d527c43c640c4d742c52aa006c3bb0) Thanks [@chengluyu](https://github.com/chengluyu)! - Correct the guidance text shown when a goal cannot be paused or resumed.

- [#1692](https://github.com/MoonshotAI/kimi-code/pull/1692) [`e53cd79`](https://github.com/MoonshotAI/kimi-code/commit/e53cd799572db6b2c73f6938703d586b83013cec) Thanks [@chengluyu](https://github.com/chengluyu)! - Allow goals to use every configured turn before the turn budget stops further work.

- [#1719](https://github.com/MoonshotAI/kimi-code/pull/1719) [`b24a347`](https://github.com/MoonshotAI/kimi-code/commit/b24a347e20a3efa7bba948316784a76439ed7cf5) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Restore the AgentSwarm member list after a page refresh on the v2 backend.

- [#1704](https://github.com/MoonshotAI/kimi-code/pull/1704) [`38a2363`](https://github.com/MoonshotAI/kimi-code/commit/38a2363a006d8ed32ff6100ccff2dc7d1a70b2b0) Thanks [@sailist](https://github.com/sailist)! - Fix sessions created by newer builds failing to open in older CLI builds on the same machine; new sessions are written in a compatible layout, and existing sessions are healed on first open.

- [#1708](https://github.com/MoonshotAI/kimi-code/pull/1708) [`ddfdfb0`](https://github.com/MoonshotAI/kimi-code/commit/ddfdfb0b09b59d95888eca7e9ddb7bb63be5e204) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Fix sub-agent completions being signaled as session turn completions, which fired premature completion notifications, sounds, and unread markers while the main turn was still running.

- [#1714](https://github.com/MoonshotAI/kimi-code/pull/1714) [`20b6972`](https://github.com/MoonshotAI/kimi-code/commit/20b69724aafc8fb0b56a414988eb762a8b8a3ed1) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Fix code block copy buttons when the web UI is served over plain HTTP.

- [#1643](https://github.com/MoonshotAI/kimi-code/pull/1643) [`d8d4e8c`](https://github.com/MoonshotAI/kimi-code/commit/d8d4e8ceb55d7a5cae7ce9b579996c9ff5601914) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Prevent long streaming responses from stalling after a tab is backgrounded.

- [#1715](https://github.com/MoonshotAI/kimi-code/pull/1715) [`de493ae`](https://github.com/MoonshotAI/kimi-code/commit/de493aeec973623bc0e258d6598f6d9215693a5f) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Use an upward chevron for the expand button on minimized plan review and question cards so the icon matches the direction the cards open.

- [#1641](https://github.com/MoonshotAI/kimi-code/pull/1641) [`b6ae0a1`](https://github.com/MoonshotAI/kimi-code/commit/b6ae0a1054635fc71efde61dafa03da8a8b0c4c8) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Show session list loading failures without discarding sessions that are still available.

- [#1719](https://github.com/MoonshotAI/kimi-code/pull/1719) [`b24a347`](https://github.com/MoonshotAI/kimi-code/commit/b24a347e20a3efa7bba948316784a76439ed7cf5) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Expand the AgentSwarm card by default while its subagents are still running.

- [#1693](https://github.com/MoonshotAI/kimi-code/pull/1693) [`7de218a`](https://github.com/MoonshotAI/kimi-code/commit/7de218a909d8f3e676ea3c160834090c9f19ca54) Thanks [@chengluyu](https://github.com/chengluyu)! - web: Resume paused goals when you select Resume.

- [#1700](https://github.com/MoonshotAI/kimi-code/pull/1700) [`3107f96`](https://github.com/MoonshotAI/kimi-code/commit/3107f963a532de88d0affd0a08c60749455c5013) Thanks [@chengluyu](https://github.com/chengluyu)! - Prevent late activity from replaced goals from changing or consuming the budget of replacement goals.

- [#1459](https://github.com/MoonshotAI/kimi-code/pull/1459) [`6eb8e13`](https://github.com/MoonshotAI/kimi-code/commit/6eb8e13417f28a553b4183f113e5b96eb31e4211) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Fix mobile safe-area handling, including the composer floating above the on-screen keyboard on iOS, doubled landscape insets, the PWA top bar under the notch, and toasts overlapping the composer as it grows.

- [#1696](https://github.com/MoonshotAI/kimi-code/pull/1696) [`b781e8c`](https://github.com/MoonshotAI/kimi-code/commit/b781e8cbcfac2cd0e73e3b1b79fa3386c632fa5b) Thanks [@chengluyu](https://github.com/chengluyu)! - Preserve final status messages when automatic goal continuations reach a budget or report a blocker.

- [#1722](https://github.com/MoonshotAI/kimi-code/pull/1722) [`3703d03`](https://github.com/MoonshotAI/kimi-code/commit/3703d0346e79e42f18b5097f5606e6ef7b0ff2dd) Thanks [@sailist](https://github.com/sailist)! - In print mode (`kimi -p`), keep the run alive by default while background tasks are pending and feed each completion back to the main agent as a new turn, with an effectively unbounded wait ceiling and turn cap and a 72-hour subagent timeout. Set `print_background_mode = "exit"` (or `"drain"`) to restore the previous exit-after-one-turn behavior.

- [#1737](https://github.com/MoonshotAI/kimi-code/pull/1737) [`5d6ff02`](https://github.com/MoonshotAI/kimi-code/commit/5d6ff022b1a3732cf0b12d1a87497870def52c0c) Thanks [@sailist](https://github.com/sailist)! - In print mode (`kimi -p`), background Bash tasks and subagents no longer have a timeout by default — they run until they finish or the model stops them, and a foreground Bash command that times out is moved to the background without a new deadline. Interactive defaults are unchanged; tune per mode with `bash_task_timeout_s` under `[background]` or `timeout_ms` under `[subagent]` (`0` = no timeout).

- [#1697](https://github.com/MoonshotAI/kimi-code/pull/1697) [`2bf009f`](https://github.com/MoonshotAI/kimi-code/commit/2bf009fe27d1b0259e90f285e94264a8bf6b5832) Thanks [@chengluyu](https://github.com/chengluyu)! - Reject subagent goal requests consistently instead of starting goals they cannot finish.

- [#1711](https://github.com/MoonshotAI/kimi-code/pull/1711) [`9eff230`](https://github.com/MoonshotAI/kimi-code/commit/9eff230f976c6bd8cc757678293276d8dec013d8) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Log failed requests, WebSocket auth rejections, shutdowns, and key operations (abort, cancel, approvals, config changes) in the web UI server so daemon problems can be diagnosed from its logs.

- [#1704](https://github.com/MoonshotAI/kimi-code/pull/1704) [`38a2363`](https://github.com/MoonshotAI/kimi-code/commit/38a2363a006d8ed32ff6100ccff2dc7d1a70b2b0) Thanks [@sailist](https://github.com/sailist)! - Fix `kimi server` reporting the internal server package version instead of the CLI version in its metadata; the web UI settings now show the CLI version.

- [#1741](https://github.com/MoonshotAI/kimi-code/pull/1741) [`8a3f1ff`](https://github.com/MoonshotAI/kimi-code/commit/8a3f1ffa6fbd7855fd0b10d96587afc6b690ebe3) Thanks [@chengluyu](https://github.com/chengluyu)! - web: Fix the session title not being generated when the first message is a skill slash command.

- [#1694](https://github.com/MoonshotAI/kimi-code/pull/1694) [`513f374`](https://github.com/MoonshotAI/kimi-code/commit/513f374aa08bd86b428f62697c1ca12594d533e9) Thanks [@chengluyu](https://github.com/chengluyu)! - Reject malformed persisted goal records during session recovery.

- [#1704](https://github.com/MoonshotAI/kimi-code/pull/1704) [`38a2363`](https://github.com/MoonshotAI/kimi-code/commit/38a2363a006d8ed32ff6100ccff2dc7d1a70b2b0) Thanks [@sailist](https://github.com/sailist)! - web: Show each message's actual send time in chat history after reloading a session, instead of the session creation time.

- [#1711](https://github.com/MoonshotAI/kimi-code/pull/1711) [`9eff230`](https://github.com/MoonshotAI/kimi-code/commit/9eff230f976c6bd8cc757678293276d8dec013d8) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Surface server error details when actions such as stopping a session, archiving, or toggling modes fail, instead of failing silently, and log every operation failure to the console and the exported web log.

- [#1701](https://github.com/MoonshotAI/kimi-code/pull/1701) [`07c3632`](https://github.com/MoonshotAI/kimi-code/commit/07c3632415fa77972c49c39d7171ee5a4790bd01) Thanks [@sailist](https://github.com/sailist)! - Keep the workspace catalog complete and durable: creating a session registers its directory as a workspace, the server backfills missing workspaces from session history at startup, and a removed workspace no longer reappears after a restart.

## 0.24.1

### Patch Changes

- [#1678](https://github.com/MoonshotAI/kimi-code/pull/1678) [`ec1c974`](https://github.com/MoonshotAI/kimi-code/commit/ec1c9748c816d152bf06af2456e82ac35786bba9) Thanks [@chengluyu](https://github.com/chengluyu)! - Preserve goal completion summaries and show untyped LLM errors without an internal error-code prefix in step interruption events.

- [#1688](https://github.com/MoonshotAI/kimi-code/pull/1688) [`94c0ef8`](https://github.com/MoonshotAI/kimi-code/commit/94c0ef89d29ea8532be02828201328fa1281273c) Thanks [@sailist](https://github.com/sailist)! - Fix built-in tools being unavailable when the model provider becomes ready after the session starts.

- [#1684](https://github.com/MoonshotAI/kimi-code/pull/1684) [`e417ee7`](https://github.com/MoonshotAI/kimi-code/commit/e417ee7c2c282f00113dc0e4f4514ca5018b76c9) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix Kimi sessions getting stuck when preserved-thinking history contains an empty reasoning step.

- [#1673](https://github.com/MoonshotAI/kimi-code/pull/1673) [`0f64b4d`](https://github.com/MoonshotAI/kimi-code/commit/0f64b4dcc4f2d295d0039b176d96d8003cb49991) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Align thinking-level handling with the CLI: submit the selected level verbatim instead of silently downgrading it, pin the model's catalog default when nothing was chosen, pre-select the target model's default on model switches, and persist explicit picks as the daemon-wide default so new sessions inherit them.

- [#1689](https://github.com/MoonshotAI/kimi-code/pull/1689) [`ab22a2a`](https://github.com/MoonshotAI/kimi-code/commit/ab22a2adf0ca17cbb94f1abdab334ebc58814e8d) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Show just the level name (e.g. Max) in the model pill instead of "thinking: max".

- [#1625](https://github.com/MoonshotAI/kimi-code/pull/1625) [`d158e0a`](https://github.com/MoonshotAI/kimi-code/commit/d158e0a7ac4e432046d56787263dd2dbac40285e) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix Thinking effort routing so non-Kimi providers preserve configured values for upstream validation, while Kimi models validate runtime selections, fall back safely during model resolution, and synchronize the effective effort back to clients.

## 0.24.0

### Minor Changes

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Add v2 session export support for packaging diagnostic zip archives.

- [#1591](https://github.com/MoonshotAI/kimi-code/pull/1591) [`83e1753`](https://github.com/MoonshotAI/kimi-code/commit/83e175399f4dc3dfc3bb478543ff5897a24dfa3d) Thanks [@liruifengv](https://github.com/liruifengv)! - Move foreground Bash commands that hit their timeout to the background instead of killing them, so long-running commands survive the timeout and report back on completion. Set `bash_auto_background_on_timeout = false` under `[background]` in config.toml to restore the kill-on-timeout behavior.

- [#1617](https://github.com/MoonshotAI/kimi-code/pull/1617) [`4ec2e7f`](https://github.com/MoonshotAI/kimi-code/commit/4ec2e7fab14ab89cddf77821082c3ff4911f737b) Thanks [@sailist](https://github.com/sailist)! - Run the local server (`kimi server run` / `kimi web`) on the agent-core-v2 engine by default — the `KIMI_CODE_EXPERIMENTAL_FLAG` opt-in is no longer needed, and the legacy v1 server package has been removed.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Port progressive tool disclosure to the new agent engine: MCP tool schemas stay out of the top-level tool list, and the model loads them by name on demand through the announcements plus the select_tools tool, keeping the prompt cache stable. Off by default; set KIMI_CODE_EXPERIMENTAL_TOOL_SELECT=1 to enable.

- [#1646](https://github.com/MoonshotAI/kimi-code/pull/1646) [`5eb6217`](https://github.com/MoonshotAI/kimi-code/commit/5eb62178b3b67d8659788bdf91132469f6588653) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Add session diagnostic export to download a session and bounded metadata-only troubleshooting logs as a ZIP. Run `/export` or pick Export session from a session's more menu. Web downloads are limited to 64 MiB.

### Patch Changes

- [#1638](https://github.com/MoonshotAI/kimi-code/pull/1638) [`7c889f3`](https://github.com/MoonshotAI/kimi-code/commit/7c889f3a960482cc9382203bda55d972b6fb6acd) Thanks [@RealKai42](https://github.com/RealKai42)! - In auto permission mode, plan exits are now marked as auto-approved (not user-reviewed) in both the tool result and the transcript, so the agent no longer treats automatic plan approval as a user signal to start executing.

- [#1598](https://github.com/MoonshotAI/kimi-code/pull/1598) [`4feca6b`](https://github.com/MoonshotAI/kimi-code/commit/4feca6b0738ee0120ab8bea04604b8f467a72e48) Thanks [@kermanx](https://github.com/kermanx)! - web: Recover transient subagent rate limits without surfacing them as session errors.

- [#1635](https://github.com/MoonshotAI/kimi-code/pull/1635) [`e49b3b8`](https://github.com/MoonshotAI/kimi-code/commit/e49b3b877750ba5ca0ea80e154549d5b53455575) Thanks [@sailist](https://github.com/sailist)! - Request task-owned work to stop on session close, honoring `background.keep_alive_on_exit` for independent processes and `background.kill_grace_period_ms` before attempting force-stop.

- [#1629](https://github.com/MoonshotAI/kimi-code/pull/1629) [`0527ca2`](https://github.com/MoonshotAI/kimi-code/commit/0527ca2267f8cf355d0c158953f3dbfc0c9692ac) Thanks [@sailist](https://github.com/sailist)! - Fix session fork losing everything except the conversation log: forked sessions now carry over media attachments, plan files, background task output, and cron tasks, and a failed fork no longer leaves a broken half-copy behind.

- [#1627](https://github.com/MoonshotAI/kimi-code/pull/1627) [`28e9dd4`](https://github.com/MoonshotAI/kimi-code/commit/28e9dd4d627f01143b715976cb071e7d16cd2001) Thanks [@chengluyu](https://github.com/chengluyu)! - web: Continue blocked goals after the user resumes them from the goal controls.

- [#1631](https://github.com/MoonshotAI/kimi-code/pull/1631) [`2d874fb`](https://github.com/MoonshotAI/kimi-code/commit/2d874fbd73eb511e4ef4c8d4c88bd47e429580b2) Thanks [@sailist](https://github.com/sailist)! - Fix a race where a heartbeat write in flight during server shutdown could recreate the instance file right after it was removed.

- [#1663](https://github.com/MoonshotAI/kimi-code/pull/1663) [`1294a0e`](https://github.com/MoonshotAI/kimi-code/commit/1294a0e1ad739151573163505f9c58afb2d543e4) Thanks [@7Sageer](https://github.com/7Sageer)! - Fix OAuth login hanging after browser authorization when the provider configuration changes during sign-in.

- [#1657](https://github.com/MoonshotAI/kimi-code/pull/1657) [`32a89c3`](https://github.com/MoonshotAI/kimi-code/commit/32a89c36432f9aea452a697734102a7956e42e92) Thanks [@RealKai42](https://github.com/RealKai42)! - Prevent oversized image reads from poisoning sessions and recover existing request-too-large failures by removing unsafe media from provider requests.

- [#1635](https://github.com/MoonshotAI/kimi-code/pull/1635) [`e49b3b8`](https://github.com/MoonshotAI/kimi-code/commit/e49b3b877750ba5ca0ea80e154549d5b53455575) Thanks [@sailist](https://github.com/sailist)! - Store background task records per agent again, so tasks written by older versions are found on resume and one agent's restore no longer marks another agent's tasks as lost.

- [#1632](https://github.com/MoonshotAI/kimi-code/pull/1632) [`a4aae87`](https://github.com/MoonshotAI/kimi-code/commit/a4aae87cd9a240d3567601ed1a9aefaab540b075) Thanks [@sailist](https://github.com/sailist)! - Fix providers without a configured base_url being rejected: anthropic/openai and other protocol providers now fall back to their official default endpoints again, as before.

- [#1588](https://github.com/MoonshotAI/kimi-code/pull/1588) [`2061590`](https://github.com/MoonshotAI/kimi-code/commit/20615902c2c3776d17c6c334cedec1c8723222b1) Thanks [@liruifengv](https://github.com/liruifengv)! - Fix pasted media being dropped from /skill and plugin command arguments.

- [#1588](https://github.com/MoonshotAI/kimi-code/pull/1588) [`2061590`](https://github.com/MoonshotAI/kimi-code/commit/20615902c2c3776d17c6c334cedec1c8723222b1) Thanks [@liruifengv](https://github.com/liruifengv)! - Fix pasted images being dropped when steering with Ctrl-S.

- [#1629](https://github.com/MoonshotAI/kimi-code/pull/1629) [`0527ca2`](https://github.com/MoonshotAI/kimi-code/commit/0527ca2267f8cf355d0c158953f3dbfc0c9692ac) Thanks [@sailist](https://github.com/sailist)! - Fix the v2 engine never activating tool-call deduplication: identical tool calls issued in the same step no longer execute multiple times, and repeated identical calls across steps receive escalating reminders again.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Fix a race in the experimental v2 config service that could drop a just-written setting from the config response.

- [#1614](https://github.com/MoonshotAI/kimi-code/pull/1614) [`3c0e368`](https://github.com/MoonshotAI/kimi-code/commit/3c0e368cbdfebff9632cffca3b18365615a146b8) Thanks [@chengluyu](https://github.com/chengluyu)! - Fix a server crash when the first goal-mode prompt is submitted while the v2 agent is still starting.

- [#1631](https://github.com/MoonshotAI/kimi-code/pull/1631) [`2d874fb`](https://github.com/MoonshotAI/kimi-code/commit/2d874fbd73eb511e4ef4c8d4c88bd47e429580b2) Thanks [@sailist](https://github.com/sailist)! - Surface the provider's actual rejection message instead of a misleading re-login prompt when an OAuth-managed model keeps returning 401 after a token refresh.

- [#1631](https://github.com/MoonshotAI/kimi-code/pull/1631) [`2d874fb`](https://github.com/MoonshotAI/kimi-code/commit/2d874fbd73eb511e4ef4c8d4c88bd47e429580b2) Thanks [@sailist](https://github.com/sailist)! - Rewrite repeated-tool-call reminders to redirect the agent toward a different action instead of prohibiting the call, and treat a dismissed question prompt as no answer rather than the recommended option.

- [#1636](https://github.com/MoonshotAI/kimi-code/pull/1636) [`8027fe2`](https://github.com/MoonshotAI/kimi-code/commit/8027fe291b03fbfce6dc60aa06f8699ad0976ec5) Thanks [@sailist](https://github.com/sailist)! - Make file tools able to reach skill directories outside the working directory in the v2 engine (experimental), and honor --skillsDir in v2 print mode and the server's skillDirs option.

- [#1630](https://github.com/MoonshotAI/kimi-code/pull/1630) [`0303b82`](https://github.com/MoonshotAI/kimi-code/commit/0303b82c3e691836163ecf906febfb6324c81d74) Thanks [@sailist](https://github.com/sailist)! - Fix ReadMediaFile results losing their image rendering after a session reload or resume on the v2 server backend.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Fix a storage race in the experimental v2 engine that could fail value reads when writes overlap with compaction.

- [#1601](https://github.com/MoonshotAI/kimi-code/pull/1601) [`dc309a7`](https://github.com/MoonshotAI/kimi-code/commit/dc309a7dfb38b6ef885b8ae80be51b49f8486207) Thanks [@kermanx](https://github.com/kermanx)! - web: Fix the context usage indicator dropping to 0 when a session is reopened or the session list reloads (e.g. after a sidebar search) — the cached live usage is now kept instead of the session record's all-zero placeholder.

- [#1620](https://github.com/MoonshotAI/kimi-code/pull/1620) [`e91a616`](https://github.com/MoonshotAI/kimi-code/commit/e91a616f2196ab9ffc69b3fcc0f2015398d86bd4) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Fix duplicate user message bubbles after a session snapshot resync.

- [#1672](https://github.com/MoonshotAI/kimi-code/pull/1672) [`88629ba`](https://github.com/MoonshotAI/kimi-code/commit/88629bac3add2a8a17ae8288ee4edbdc9313d55a) Thanks [@yicun](https://github.com/yicun)! - web: Fix uploaded and persisted images failing to display on non-loopback server connections.

- [#1609](https://github.com/MoonshotAI/kimi-code/pull/1609) [`e223549`](https://github.com/MoonshotAI/kimi-code/commit/e223549a79c80e442850947c0cf60d58b2d18667) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Fix a running multi-step turn rendering a duplicated wall of text after the page reconnects or refreshes mid-turn.

- [#1611](https://github.com/MoonshotAI/kimi-code/pull/1611) [`32cbd0c`](https://github.com/MoonshotAI/kimi-code/commit/32cbd0cf6109f4f3f124e6e4ee7c4c87fa344247) Thanks [@chengluyu](https://github.com/chengluyu)! - web: Fix the workspace picker menu sizing too narrowly for its content.

- [#1635](https://github.com/MoonshotAI/kimi-code/pull/1635) [`e49b3b8`](https://github.com/MoonshotAI/kimi-code/commit/e49b3b877750ba5ca0ea80e154549d5b53455575) Thanks [@sailist](https://github.com/sailist)! - Fix possible record loss when resuming sessions whose wire log needs migration, and reject session logs missing the version envelope instead of silently misreading them.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Fix MCP tools being unavailable on the first turn after session startup.

- [#1580](https://github.com/MoonshotAI/kimi-code/pull/1580) [`83370f1`](https://github.com/MoonshotAI/kimi-code/commit/83370f17ef38770561a421e3b3a15f6244219aa5) Thanks [@wszqkzqk](https://github.com/wszqkzqk)! - Fix bash auto-detection on Windows failing when git comes from a native MSYS2 toolchain (ucrt64/clang64/clangarm64).

- [#1676](https://github.com/MoonshotAI/kimi-code/pull/1676) [`d1820ff`](https://github.com/MoonshotAI/kimi-code/commit/d1820ff0f853689e84b3e9d4c482532c481eb9bd) Thanks [@RealKai42](https://github.com/RealKai42)! - Preserve empty model reasoning blocks across providers so multi-step tool calls can continue.

- [#1669](https://github.com/MoonshotAI/kimi-code/pull/1669) [`490303d`](https://github.com/MoonshotAI/kimi-code/commit/490303db16ed374eae20572e4c6f9880db911547) Thanks [@chengluyu](https://github.com/chengluyu)! - web: Refine goal mode controls with animated strip interactions, budget-aware progress, and design-system cancellation confirmation.

- [#1597](https://github.com/MoonshotAI/kimi-code/pull/1597) [`d601847`](https://github.com/MoonshotAI/kimi-code/commit/d601847f22366b041d949d7c9f7857471be8970c) Thanks [@7Sageer](https://github.com/7Sageer)! - Send the kimi-code-cli User-Agent on provider registry (api.json) and model catalog fetches, so registries can identify the client version.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Fix approval and question prompts not appearing in real time for web clients connected to the v2 server; they previously only showed up after a page refresh.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Log a warning when a skill fails to parse instead of silently dropping it, and fix the skill catalog so scanned skill roots and policy-skipped skills are actually reported.

- [#1589](https://github.com/MoonshotAI/kimi-code/pull/1589) [`f338fcd`](https://github.com/MoonshotAI/kimi-code/commit/f338fcdac4fa8d4235c44310953e5d512f6549fb) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Fix the AgentSwarm member list disappearing after a page refresh while subagents are still running.

- [#1591](https://github.com/MoonshotAI/kimi-code/pull/1591) [`83e1753`](https://github.com/MoonshotAI/kimi-code/commit/83e175399f4dc3dfc3bb478543ff5897a24dfa3d) Thanks [@liruifengv](https://github.com/liruifengv)! - Optimize the TaskOutput tool prompts to discourage blocking waits on background tasks.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Enforce a typed registry for v2 engine telemetry events and redact URLs, tokens, and file paths from outgoing telemetry properties.

- [#1624](https://github.com/MoonshotAI/kimi-code/pull/1624) [`3215129`](https://github.com/MoonshotAI/kimi-code/commit/321512986099037acb4b2677d4455db316d27b50) Thanks [@kermanx](https://github.com/kermanx)! - Fix the experimental v2 engine crashing when the first prompt is sent right after a new conversation is created (for example sending /goal on the web's new-conversation page): agent creation now joins the in-flight bootstrap instead of failing, and the v2 agent lifecycle is split into focused existence, sub-agent, and session MCP domains.

- [#1637](https://github.com/MoonshotAI/kimi-code/pull/1637) [`0e0a6e9`](https://github.com/MoonshotAI/kimi-code/commit/0e0a6e9a5170c28c5e6809c1b2cf6d6f8904de73) Thanks [@sailist](https://github.com/sailist)! - Support caller-supplied MCP server configs on session create in the v2 engine (experimental), merged over the file config and under plugin servers.

- [#1626](https://github.com/MoonshotAI/kimi-code/pull/1626) [`1c85f94`](https://github.com/MoonshotAI/kimi-code/commit/1c85f94472ead2746ad6860ec0e09f4384dd95ec) Thanks [@sailist](https://github.com/sailist)! - v2 engine: expose the prompt scheduler over /api/v2 for native clients, and add an experimental fault-injection service (KIMI_CODE_EXPERIMENTAL_FAULT_INJECTION) that arms a one-shot provider failure so the media-degraded / media-stripped recovery resends can be exercised end-to-end.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Introduce a graded error taxonomy for the v2 engine's filesystem, storage, and wire layers, translating raw OS and parse failures into specific error codes instead of generic internal errors.

- [#1626](https://github.com/MoonshotAI/kimi-code/pull/1626) [`1c85f94`](https://github.com/MoonshotAI/kimi-code/commit/1c85f94472ead2746ad6860ec0e09f4384dd95ec) Thanks [@sailist](https://github.com/sailist)! - v2 engine: block unsupported image formats (AVIF, HEIC, BMP, TIFF, ICO) at every ingestion point so they can no longer poison session history, and auto-recover provider image-format rejections with a media-stripped resend.

- [#1626](https://github.com/MoonshotAI/kimi-code/pull/1626) [`1c85f94`](https://github.com/MoonshotAI/kimi-code/commit/1c85f94472ead2746ad6860ec0e09f4384dd95ec) Thanks [@sailist](https://github.com/sailist)! - v2 engine: recover image-heavy sessions from provider request-size rejections (HTTP 413) by resending with older media degraded to text markers, re-encode oversized WebP images instead of passing them through, and keep downscaled PNGs readable by switching to JPEG below 1000px.

- [#1613](https://github.com/MoonshotAI/kimi-code/pull/1613) [`b2daa40`](https://github.com/MoonshotAI/kimi-code/commit/b2daa405f075cb6847c0a313809b1bcac750b611) Thanks [@7Sageer](https://github.com/7Sageer)! - Support the `services.moonshot_search` api-key config for WebSearch in the v2 engine, matching v1: the tool is now available without an OAuth login, and explicit config takes precedence over the OAuth-derived provider.

- [#1590](https://github.com/MoonshotAI/kimi-code/pull/1590) [`8a4ee05`](https://github.com/MoonshotAI/kimi-code/commit/8a4ee05951ebe4f804fd1fb0989aaf44b3b7a3ed) Thanks [@sailist](https://github.com/sailist)! - Fix bash auto-detection on Windows in the experimental v2 engine when git comes from a native MSYS2 toolchain (ucrt64/clang64/clangarm64).

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Send the CLI identity headers (User-Agent and device identity) with outbound requests from the experimental v2 server, matching direct CLI runs.

- [#1593](https://github.com/MoonshotAI/kimi-code/pull/1593) [`2185237`](https://github.com/MoonshotAI/kimi-code/commit/2185237c2f5c5fb3cc6b44c01ac158c6e2b81fe6) Thanks [@kermanx](https://github.com/kermanx)! - Declare v2 engine wire op payloads with required zod schemas and derive their types from the schemas, with ops declared on their models and every op type registered for replay classification.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Keep sessions from the new agent engine compatible with existing transcript replay.

- [#1592](https://github.com/MoonshotAI/kimi-code/pull/1592) [`924d5c9`](https://github.com/MoonshotAI/kimi-code/commit/924d5c914143d178020c2dddc56906ce15088680) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Show the connected backend engine (v1 / v2) in Settings, and add a dev-mode backend pill next to the sidebar brand that can switch the dev proxy between the two engines at runtime.

- [#1606](https://github.com/MoonshotAI/kimi-code/pull/1606) [`2da45fc`](https://github.com/MoonshotAI/kimi-code/commit/2da45fc419cf5285a9353df8690bba444037ffe4) Thanks [@liruifengv](https://github.com/liruifengv)! - web: Fix the goal card disappearing after a page refresh while a session goal is active.

- [#1587](https://github.com/MoonshotAI/kimi-code/pull/1587) [`49a8c84`](https://github.com/MoonshotAI/kimi-code/commit/49a8c84a493610c2b2cc2c7da0a8ec0261d876db) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Let wide Markdown tables in the desktop chat grow up to 1040px with each column capped at 700px so long cell content wraps, temporarily hiding the conversation outline while a table passes under it; anything wider still scrolls inside the table.

## 0.23.6

### Patch Changes

- [#1550](https://github.com/MoonshotAI/kimi-code/pull/1550) [`f17a6ec`](https://github.com/MoonshotAI/kimi-code/commit/f17a6ecb52907ffabf67a26de65df89572ac515a) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Treat a dismissed question prompt as the user choosing not to answer, instead of implicitly selecting the recommended option.

- [#1488](https://github.com/MoonshotAI/kimi-code/pull/1488) [`7bd29ab`](https://github.com/MoonshotAI/kimi-code/commit/7bd29ab0117a1c15691404f411fd67f511bbb897) Thanks [@starquakee](https://github.com/starquakee)! - Rename the dynamic tool loading model capability from `select_tools` to `dynamically_loaded_tools`.

- [#1497](https://github.com/MoonshotAI/kimi-code/pull/1497) [`c6e02da`](https://github.com/MoonshotAI/kimi-code/commit/c6e02daf421b47e8451e60ed4d7b3847a895d00b) Thanks [@sailist](https://github.com/sailist)! - Add a print-mode background policy that lets `kimi -p` stay alive across background-task completions so the main agent can be steered into follow-up turns. Set `[background].print_background_mode = "steer"` to enable it.

- [#1555](https://github.com/MoonshotAI/kimi-code/pull/1555) [`2f97917`](https://github.com/MoonshotAI/kimi-code/commit/2f97917bb5edc8bdb9837724e57a88f5c0e1f2bd) Thanks [@sailist](https://github.com/sailist)! - Keep `kimi -p` runs alive after a turn ends while a goal is still active or a cron task is pending, so goal continuations and cron fires run their turns instead of being cut off when the main turn finishes.

- [#1564](https://github.com/MoonshotAI/kimi-code/pull/1564) [`cc03816`](https://github.com/MoonshotAI/kimi-code/commit/cc03816ee0a89b272c1ab87ca43ed246833f0453) Thanks [@sailist](https://github.com/sailist)! - Recognize the support_efforts and default_effort fields when importing a custom registry, so thinking effort levels are available for those models.

- [#1562](https://github.com/MoonshotAI/kimi-code/pull/1562) [`faefad0`](https://github.com/MoonshotAI/kimi-code/commit/faefad0e290ceacb89851baa42043c8685b08dc9) Thanks [@sailist](https://github.com/sailist)! - Add a `subagent.timeout_ms` config option to control how long a single subagent may run before timing out, and raise the default from 30 minutes to 2 hours. Set `[subagent] timeout_ms` in config.toml (or the `KIMI_SUBAGENT_TIMEOUT_MS` env var) to adjust it.

- [#1572](https://github.com/MoonshotAI/kimi-code/pull/1572) [`3a7aad6`](https://github.com/MoonshotAI/kimi-code/commit/3a7aad653f1226ce4e2c7103318471f65154c406) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Fix sessions getting stuck in a sending state after a reconnect, so the working spinner stops and the next message sends normally once a turn finishes while the connection is down.

- [#1574](https://github.com/MoonshotAI/kimi-code/pull/1574) [`b1942bd`](https://github.com/MoonshotAI/kimi-code/commit/b1942bd5718c46991ba5021b4ae96dbf2458617c) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Fix the first visit after starting or updating the web UI bouncing to the login page when the initial auth check fails; the connecting screen now stays up, shows the connection error, and retries until the server answers.

- [#1553](https://github.com/MoonshotAI/kimi-code/pull/1553) [`264525e`](https://github.com/MoonshotAI/kimi-code/commit/264525eb51f87409a8961bcf3f5f0271ab767c49) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Fix the chat view jumping downward while scrolling through conversation history.

- [#1565](https://github.com/MoonshotAI/kimi-code/pull/1565) [`1d3dba5`](https://github.com/MoonshotAI/kimi-code/commit/1d3dba56832b69628f3bb22ce240f38a08f0af3a) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Fix the model dropdown showing checkmarks on same-named models from other providers; the current model is now matched by its unique model id.

- [#1567](https://github.com/MoonshotAI/kimi-code/pull/1567) [`f901b9e`](https://github.com/MoonshotAI/kimi-code/commit/f901b9e1da9a9575b5d47dba40babe2ccd035180) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Keep the server access token for up to 7 days across tab close and browser restarts, instead of asking for it again with every new tab.

- [#1552](https://github.com/MoonshotAI/kimi-code/pull/1552) [`37bb4b8`](https://github.com/MoonshotAI/kimi-code/commit/37bb4b870edf6a5458dda755a5b4a432c32df2a7) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Fix ReadMediaFile results rendering as plain tool cards instead of images after resuming or reloading a session.

- [#1563](https://github.com/MoonshotAI/kimi-code/pull/1563) [`c982386`](https://github.com/MoonshotAI/kimi-code/commit/c98238699c1ae51a2237969b43282373fc0c0e89) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Fix sidebar lag with many sessions by removing repeated session list scans during rendering.

- [#1475](https://github.com/MoonshotAI/kimi-code/pull/1475) [`5a208cb`](https://github.com/MoonshotAI/kimi-code/commit/5a208cb041530e320f343a46e231bf3c109e30c9) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Auto-enable the default thinking effort when switching to a model that supports effort levels in the web UI.

- [#1577](https://github.com/MoonshotAI/kimi-code/pull/1577) [`6fc1deb`](https://github.com/MoonshotAI/kimi-code/commit/6fc1deb45312574a9e97ffaf6d7ced530d38910d) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Let wide Markdown tables in the desktop chat grow beyond the reading column up to 1040px, temporarily hiding the conversation outline while a table passes under it; anything wider still scrolls inside the table.

- [#1575](https://github.com/MoonshotAI/kimi-code/pull/1575) [`9d96b53`](https://github.com/MoonshotAI/kimi-code/commit/9d96b538bf4311fdf07aa262a1b4141f7bdd83ed) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Let wide Markdown tables scroll horizontally inside the table instead of being squeezed into the reading column.

- [#1556](https://github.com/MoonshotAI/kimi-code/pull/1556) [`d2c2c33`](https://github.com/MoonshotAI/kimi-code/commit/d2c2c33f3e89c7c9ed06aa7c2376b88b6107e41d) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Add workspaces by typing an absolute path directly in the workspace picker's search box, with live validation and completion suggestions.

- [#1547](https://github.com/MoonshotAI/kimi-code/pull/1547) [`19c5aa6`](https://github.com/MoonshotAI/kimi-code/commit/19c5aa64ebef86925ad58074ebcac6a5a7a8ff8d) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Update the WebBridge install page link opened from the /plugins panel.

## 0.23.5

### Patch Changes

- [#1542](https://github.com/MoonshotAI/kimi-code/pull/1542) [`f80b2ea`](https://github.com/MoonshotAI/kimi-code/commit/f80b2eaf04925ce920f693fc8d4d81cb00e825d7) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Fix the "Turn finished" desktop notification and completion sound firing twice per turn.

- [#1535](https://github.com/MoonshotAI/kimi-code/pull/1535) [`04041eb`](https://github.com/MoonshotAI/kimi-code/commit/04041eb998b6798898fa5df97f7587b3aa119b27) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Hide the internal image-compression note so it no longer renders as user message text.

- [#1536](https://github.com/MoonshotAI/kimi-code/pull/1536) [`db61c9e`](https://github.com/MoonshotAI/kimi-code/commit/db61c9e2dddcb6c35b019ef7f374385248ece881) Thanks [@RealKai42](https://github.com/RealKai42)! - Stop unsupported image formats (AVIF, BMP, TIFF, ICO, …) from breaking sessions at every entry point — including remote image URLs and images mislabeled by a tool — and recover an already-stuck session by dropping the offending image and retrying, so one such image can no longer make every later request fail.

- [#1530](https://github.com/MoonshotAI/kimi-code/pull/1530) [`9f66ec4`](https://github.com/MoonshotAI/kimi-code/commit/9f66ec416cc658842dc1414b79b6447d1b4cc7f9) Thanks [@sailist](https://github.com/sailist)! - Retry provider 429, overload, and other transient errors more reliably, honoring the server Retry-After delay, and surface retries in `-p --output-format stream-json`.

## 0.23.4

### Patch Changes

- [#1501](https://github.com/MoonshotAI/kimi-code/pull/1501) [`b91099e`](https://github.com/MoonshotAI/kimi-code/commit/b91099ed7a2590d1afa4d6e3675671da52b7661c) Thanks [@liruifengv](https://github.com/liruifengv)! - Display Extra Usage (fuel pack) balance in `/usage` and `/status` commands.

- [#1517](https://github.com/MoonshotAI/kimi-code/pull/1517) [`173bdfd`](https://github.com/MoonshotAI/kimi-code/commit/173bdfdab1f484ed79927aeaac7dc8116d3fd346) Thanks [@chengluyu](https://github.com/chengluyu)! - Fix resuming sessions whose original working directory no longer exists.

- [#1516](https://github.com/MoonshotAI/kimi-code/pull/1516) [`9fb1915`](https://github.com/MoonshotAI/kimi-code/commit/9fb19154accf6b6f7abfbf7a9820ccda517bc87e) Thanks [@chengluyu](https://github.com/chengluyu)! - Fix prompt-mode goals so they run until completion and report invalid goal commands before sending prompts.

- [#1508](https://github.com/MoonshotAI/kimi-code/pull/1508) [`1bf2c9a`](https://github.com/MoonshotAI/kimi-code/commit/1bf2c9afee4643fbf6755f0b92fd60aa14240501) Thanks [@RealKai42](https://github.com/RealKai42)! - Keep image-heavy sessions within provider request-size limits: model-read images now honor a 256 KB per-image budget and a 2000px downscale cap (configurable via `[image]` in config.toml or `KIMI_IMAGE_*` env vars), oversized WebP is compressed as well, HEIC/HEIF reads are refused with a platform-matched conversion command instead of poisoning the session, and a request-too-large rejection (HTTP 413) now recovers automatically — the request and /compact both retry with older media replaced by text markers instead of failing the session.

- [#1519](https://github.com/MoonshotAI/kimi-code/pull/1519) [`170ae44`](https://github.com/MoonshotAI/kimi-code/commit/170ae4420526b6592d696cd597d1693dbd1a660b) Thanks [@liruifengv](https://github.com/liruifengv)! - web: Polish the session sidebar layout, colors, icons, and typography.

- [#1521](https://github.com/MoonshotAI/kimi-code/pull/1521) [`046b6c4`](https://github.com/MoonshotAI/kimi-code/commit/046b6c417581792933732c7ffe154e120c96171d) Thanks [@RealKai42](https://github.com/RealKai42)! - The `[image]` limits in config.toml now also apply to pasted images (CLI paste and ACP prompts), and each core now uses its own settings, so reloading one client's config no longer changes another client's image compression.

- [#1494](https://github.com/MoonshotAI/kimi-code/pull/1494) [`a354803`](https://github.com/MoonshotAI/kimi-code/commit/a3548035a8b6d25df9a11daab37a21daee1ef73f) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Add a Kimi WebBridge entry to the Official tab of the /plugins panel that opens the WebBridge install page in your browser.

- [#1479](https://github.com/MoonshotAI/kimi-code/pull/1479) [`735922c`](https://github.com/MoonshotAI/kimi-code/commit/735922c291ec3d32d60da6af053f75e1c6179f92) Thanks [@liruifengv](https://github.com/liruifengv)! - web: Add notifications when a tool needs approval, and improve notification reliability.

- [#1522](https://github.com/MoonshotAI/kimi-code/pull/1522) [`ec8dc34`](https://github.com/MoonshotAI/kimi-code/commit/ec8dc3456c1696a5eba6c37b6e26ef99837c35e2) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Fix an occasional "another turn is active" error when sending the first message of a new conversation, and show a starting state while it is being sent.

- [#1502](https://github.com/MoonshotAI/kimi-code/pull/1502) [`ad30a1c`](https://github.com/MoonshotAI/kimi-code/commit/ad30a1c6328327729221f9f5fc700b621dfef779) Thanks [@chengluyu](https://github.com/chengluyu)! - web: Polish the chat UI with Inter typography, localized labels, and tighter sidebar, composer, and menu styling.

## 0.23.3

### Patch Changes

- [#1506](https://github.com/MoonshotAI/kimi-code/pull/1506) [`e83511a`](https://github.com/MoonshotAI/kimi-code/commit/e83511a7118652a67676bbcfd41148907ad7b8de) Thanks [@7Sageer](https://github.com/7Sageer)! - Fix a misleading "OAuth login expired" message shown when a model is not available for the current account.

## 0.23.2

### Patch Changes

- [#1489](https://github.com/MoonshotAI/kimi-code/pull/1489) [`2206d21`](https://github.com/MoonshotAI/kimi-code/commit/2206d21327129aa2331b6b159cfce61110b7f94f) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Add the Vercel plugin to the bundled plugin marketplace. Run /plugins and select Vercel Plugin to install it.

- [#1477](https://github.com/MoonshotAI/kimi-code/pull/1477) [`150206a`](https://github.com/MoonshotAI/kimi-code/commit/150206a6f7027879df954e26736b4baa5d336235) Thanks [@chengluyu](https://github.com/chengluyu)! - Count the turn that starts an autonomous goal toward its goal turn usage.

- [#1483](https://github.com/MoonshotAI/kimi-code/pull/1483) [`f30781b`](https://github.com/MoonshotAI/kimi-code/commit/f30781bb273321f3e3bbb548a9d0724ab6299fc6) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Fix `kimi -p` runs exiting with code 0 when a turn fails.

- [#1466](https://github.com/MoonshotAI/kimi-code/pull/1466) [`063bce2`](https://github.com/MoonshotAI/kimi-code/commit/063bce2a2f52601abaa0d13173ab88371cbbe9ae) Thanks [@liruifengv](https://github.com/liruifengv)! - Fix console windows flashing on Windows each time a hook runs.

- [#1474](https://github.com/MoonshotAI/kimi-code/pull/1474) [`11c6a37`](https://github.com/MoonshotAI/kimi-code/commit/11c6a37ce030f8e64de5c810da07ec7fab3b0615) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Fix the connection error toast lingering after the WebSocket reconnects when returning from the background.

- [#1476](https://github.com/MoonshotAI/kimi-code/pull/1476) [`d1a964f`](https://github.com/MoonshotAI/kimi-code/commit/d1a964fba9b3dca902ea6f81bacaccc839955c03) Thanks [@chengluyu](https://github.com/chengluyu)! - Prevent autonomous goals from being paused by model-reported status updates.

- [#1481](https://github.com/MoonshotAI/kimi-code/pull/1481) [`1317000`](https://github.com/MoonshotAI/kimi-code/commit/131700097a732b97b3d17c5e2efa1c5a44b013ef) Thanks [@chengluyu](https://github.com/chengluyu)! - Tighten goal-mode guidance for blocked and complete status updates.

- [#1460](https://github.com/MoonshotAI/kimi-code/pull/1460) [`474ce28`](https://github.com/MoonshotAI/kimi-code/commit/474ce289dd39aa42d1a77a9a2e15531aee49aa15) Thanks [@RealKai42](https://github.com/RealKai42)! - Raise the image downscale cap from 2000px to 3000px, and fix swapped width/height for EXIF-rotated (portrait) photos in compression captions and media read notes so region readback coordinates map correctly.

- [#1467](https://github.com/MoonshotAI/kimi-code/pull/1467) [`ee38545`](https://github.com/MoonshotAI/kimi-code/commit/ee385456d0eda380fec067db92c025462db13f5a) Thanks [@liruifengv](https://github.com/liruifengv)! - web: Compile icons at build time so the bundled web UI only carries the icons it renders.

- [#1471](https://github.com/MoonshotAI/kimi-code/pull/1471) [`9b76e5b`](https://github.com/MoonshotAI/kimi-code/commit/9b76e5bff631cceaeecb2b0cbc096533c5fdc8cc) Thanks [@starquakee](https://github.com/starquakee)! - Progressive tool disclosure (`select_tools`, experimental): compaction now discards the loaded tool schemas instead of re-injecting them. After a compaction the boundary announcement re-lists every loadable tool name and the model re-selects what it still needs; a from-memory call to a no-longer-loaded tool is rejected with guidance to select it first. This keeps the post-compaction context at its minimal users+summary floor and removes the schema-rebuild budget heuristics. No effect unless the `tool-select` experimental flag and a `select_tools`-capable model are active.

- [#1491](https://github.com/MoonshotAI/kimi-code/pull/1491) [`0cc9831`](https://github.com/MoonshotAI/kimi-code/commit/0cc9831a2f79d93903259bd3353e746abac01b67) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: The composer model switcher switches the active session's model as before and additionally bumps the global default model, so new sessions inherit the choice.

- [#1490](https://github.com/MoonshotAI/kimi-code/pull/1490) [`b30a45e`](https://github.com/MoonshotAI/kimi-code/commit/b30a45efecfa5ece4f4f10f2c5403ba097e7690b) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Press Enter to confirm in archive and other confirmation dialogs.

- [#1480](https://github.com/MoonshotAI/kimi-code/pull/1480) [`2ad0120`](https://github.com/MoonshotAI/kimi-code/commit/2ad0120c2a5c8383892e4da1ee7c6853926ed365) Thanks [@liruifengv](https://github.com/liruifengv)! - web: Redesign the scheduled reminder UI.

- [#1492](https://github.com/MoonshotAI/kimi-code/pull/1492) [`b0809dd`](https://github.com/MoonshotAI/kimi-code/commit/b0809ddac833d8d920d95187f7ef64f97bafdbc6) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Show session skills in the slash menu as `/skill:<name>` so they are distinguishable from built-in commands; typing the bare skill name still works.

## 0.23.1

### Patch Changes

- [#1432](https://github.com/MoonshotAI/kimi-code/pull/1432) [`25a655c`](https://github.com/MoonshotAI/kimi-code/commit/25a655cf88b2f5861f9c0b7ea95ba9308f48d23a) Thanks [@RealKai42](https://github.com/RealKai42)! - Preserve prior turns' thinking by default on the Anthropic provider (Claude and Kimi's Anthropic-compatible mode), matching the Kimi default. Disable with `[thinking] keep = "off"` or `KIMI_MODEL_THINKING_KEEP=off`.

- [#1451](https://github.com/MoonshotAI/kimi-code/pull/1451) [`16dc940`](https://github.com/MoonshotAI/kimi-code/commit/16dc940834d9cc693b1f0022c4c70ef0004a6102) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Recover chat streaming after a stale background-tab WebSocket instead of requiring a page refresh.

- [#1456](https://github.com/MoonshotAI/kimi-code/pull/1456) [`e9ef939`](https://github.com/MoonshotAI/kimi-code/commit/e9ef9399d075461c7753d1f0467bd742a81cdbf6) Thanks [@chengluyu](https://github.com/chengluyu)! - Fix goal completion and blocked updates to produce one final user-facing outcome summary from the tool result.

- [#1456](https://github.com/MoonshotAI/kimi-code/pull/1456) [`e9ef939`](https://github.com/MoonshotAI/kimi-code/commit/e9ef9399d075461c7753d1f0467bd742a81cdbf6) Thanks [@chengluyu](https://github.com/chengluyu)! - Fix goal startup and queue handling so failed starts restore permission mode and queued goals wait behind new user messages.

- [#1456](https://github.com/MoonshotAI/kimi-code/pull/1456) [`e9ef939`](https://github.com/MoonshotAI/kimi-code/commit/e9ef9399d075461c7753d1f0467bd742a81cdbf6) Thanks [@chengluyu](https://github.com/chengluyu)! - Fix goal token budgets to count model completion tokens and stop without extra continuation steps when the budget is exhausted.

- [#1452](https://github.com/MoonshotAI/kimi-code/pull/1452) [`244ec07`](https://github.com/MoonshotAI/kimi-code/commit/244ec077f98c2b498cee1d0002978b6963ccfd4d) Thanks [@sailist](https://github.com/sailist)! - Fix kimi -p abandoning background subagents that start late or run long, so their results reach the main agent.

- [#1457](https://github.com/MoonshotAI/kimi-code/pull/1457) [`260a807`](https://github.com/MoonshotAI/kimi-code/commit/260a80793a95d7796950a00bdc89cf99f8b196ad) Thanks [@liruifengv](https://github.com/liruifengv)! - Respect the --skills-dir flag in interactive mode.

- [#1445](https://github.com/MoonshotAI/kimi-code/pull/1445) [`809a88c`](https://github.com/MoonshotAI/kimi-code/commit/809a88cb34d2d5d02e43f030530bb1cd320b4a6a) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Fix `/btw [<question>]` opening an empty side chat on the new-session screen.

- [#1445](https://github.com/MoonshotAI/kimi-code/pull/1445) [`809a88c`](https://github.com/MoonshotAI/kimi-code/commit/809a88cb34d2d5d02e43f030530bb1cd320b4a6a) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Fix `/goal <objective>` silently doing nothing on the new-session screen.

- [#1445](https://github.com/MoonshotAI/kimi-code/pull/1445) [`809a88c`](https://github.com/MoonshotAI/kimi-code/commit/809a88cb34d2d5d02e43f030530bb1cd320b4a6a) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Fix slash skill activations (for example `/pre-changelog`) silently doing nothing on the new-session screen.

- [#1437](https://github.com/MoonshotAI/kimi-code/pull/1437) [`743f66e`](https://github.com/MoonshotAI/kimi-code/commit/743f66e547279916d5e37454e78b11eb4b54dca3) Thanks [@RealKai42](https://github.com/RealKai42)! - Stop showing tool-produced `<system>` metadata in tool outputs; failed tools now show their own error text.

- [#1465](https://github.com/MoonshotAI/kimi-code/pull/1465) [`bfdbce5`](https://github.com/MoonshotAI/kimi-code/commit/bfdbce593f1dd667530cbfb5b10b5659b1968e48) Thanks [@liruifengv](https://github.com/liruifengv)! - Honor explicit Anthropic `max_output_size` settings instead of clamping them to built-in ceilings.

- [#1456](https://github.com/MoonshotAI/kimi-code/pull/1456) [`e9ef939`](https://github.com/MoonshotAI/kimi-code/commit/e9ef9399d075461c7753d1f0467bd742a81cdbf6) Thanks [@chengluyu](https://github.com/chengluyu)! - Keep goal tools available to the main agent and return clear messages for invalid goal-control calls.

- [#1463](https://github.com/MoonshotAI/kimi-code/pull/1463) [`03e78ae`](https://github.com/MoonshotAI/kimi-code/commit/03e78ae19063b38119f27b1bc89097a09614c0ce) Thanks [@chengluyu](https://github.com/chengluyu)! - Fix newer Claude minor versions (e.g. Opus 4.8) defaulting to the family-baseline max output tokens; an uncatalogued minor now reuses the nearest earlier known version's limit.

- [#1456](https://github.com/MoonshotAI/kimi-code/pull/1456) [`e9ef939`](https://github.com/MoonshotAI/kimi-code/commit/e9ef9399d075461c7753d1f0467bd742a81cdbf6) Thanks [@chengluyu](https://github.com/chengluyu)! - Show long-running goal wall-clock budget reminders in hours.

- [#1456](https://github.com/MoonshotAI/kimi-code/pull/1456) [`e9ef939`](https://github.com/MoonshotAI/kimi-code/commit/e9ef9399d075461c7753d1f0467bd742a81cdbf6) Thanks [@chengluyu](https://github.com/chengluyu)! - Tighten goal-mode guidance so agents continue reasonable work across turns instead of ending goals prematurely.

- [#1450](https://github.com/MoonshotAI/kimi-code/pull/1450) [`7a65e0d`](https://github.com/MoonshotAI/kimi-code/commit/7a65e0d1c0da515dbd69f1266ba7e75713e0108e) Thanks [@liruifengv](https://github.com/liruifengv)! - Clarify the permission mode descriptions shown by `/permission`, `/auto`, and `/yolo`, and reorder `/auto` and `/yolo` in the command list.

- [#1448](https://github.com/MoonshotAI/kimi-code/pull/1448) [`65d3017`](https://github.com/MoonshotAI/kimi-code/commit/65d30177adc11a56bdbbe9fbc3c4b92f96efd6bb) Thanks [@RealKai42](https://github.com/RealKai42)! - Record a per-request trace in the session wire log, so model requests can be reconstructed for debugging. Not a user-facing feature.

## 0.23.0

### Minor Changes

- [#1417](https://github.com/MoonshotAI/kimi-code/pull/1417) [`79b360c`](https://github.com/MoonshotAI/kimi-code/commit/79b360c96ad5d0af6a8c1d3a8df73adc65254d7c) Thanks [@RealKai42](https://github.com/RealKai42)! - Enable Preserved Thinking by default for Kimi models when Thinking is on, keeping prior reasoning across turns. Set `[thinking] keep = "off"` in config.toml (or `KIMI_MODEL_THINKING_KEEP=off`) to disable it.

- [#1073](https://github.com/MoonshotAI/kimi-code/pull/1073) [`6c0ce09`](https://github.com/MoonshotAI/kimi-code/commit/6c0ce09414bbfd42d8991c88c89b82c088ff2099) Thanks [@sailist](https://github.com/sailist)! - Add server APIs to restore archived sessions and list only archived sessions.

- [#1369](https://github.com/MoonshotAI/kimi-code/pull/1369) [`f0896a5`](https://github.com/MoonshotAI/kimi-code/commit/f0896a53b01f7e5b9bf5b8f93d2cd7387d765f07) Thanks [@starquakee](https://github.com/starquakee)! - Add experimental progressive tool disclosure (`select_tools`). When the `tool-select` experimental flag is on and the active model declares the `select_tools` capability, MCP tool schemas stay out of the request's top-level `tools[]` (preserving the provider prompt cache); the model loads tools on demand by exact name via the new built-in `select_tools` tool, guided by `<tools_added>/<tools_removed>` announcements. Off by default and inert on models without the capability — behavior is unchanged until a supporting model is catalogued. The SDK additionally maps the `select_tools` capability when building model aliases from a catalog and reports the new flag through `getExperimentalFeatures()`.

- [#1073](https://github.com/MoonshotAI/kimi-code/pull/1073) [`6c0ce09`](https://github.com/MoonshotAI/kimi-code/commit/6c0ce09414bbfd42d8991c88c89b82c088ff2099) Thanks [@sailist](https://github.com/sailist)! - web: Add an Archived sessions page in Settings to browse and restore archived sessions. Open Settings → Archived to find it.

- [#1425](https://github.com/MoonshotAI/kimi-code/pull/1425) [`c5e3e80`](https://github.com/MoonshotAI/kimi-code/commit/c5e3e80041a763143934c271d2524ac555d48d2a) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Replace the swarm footer with a single inline tool card that shows live subagent progress and the aggregated result, and keep swarm badges stable after refresh.

### Patch Changes

- [#1414](https://github.com/MoonshotAI/kimi-code/pull/1414) [`c12f309`](https://github.com/MoonshotAI/kimi-code/commit/c12f30951f2c278bebb42d0f61d67946c42b9577) Thanks [@RealKai42](https://github.com/RealKai42)! - AskUserQuestion now feeds answers back to the model as question text and option labels (e.g. `{"answers":{"Which database?":"Postgres"}}`) instead of synthesized ids like `q_0`/`opt_0_1`, so the model no longer has to map positional ids back to the original options — the wire protocol is unchanged, clients still answer with option ids. Question texts must now be unique per call and option labels unique per question; the web transcript card resolves both the new label form and legacy id transcripts.

- [#1408](https://github.com/MoonshotAI/kimi-code/pull/1408) [`fc259ab`](https://github.com/MoonshotAI/kimi-code/commit/fc259abdb415fe9ac10132a142bdb5ce507ccda2) Thanks [@liruifengv](https://github.com/liruifengv)! - Fix `@` file completion missing deeply nested files in large projects after adding extra workspace directories.

- [#1346](https://github.com/MoonshotAI/kimi-code/pull/1346) [`b9258ee`](https://github.com/MoonshotAI/kimi-code/commit/b9258ee07d32ff63afe9a2eb40fce6d136548fb2) Thanks [@liruifengv](https://github.com/liruifengv)! - Show compaction summaries in the TUI after compaction. Press Ctrl-O to show or hide the summary.

- [#1419](https://github.com/MoonshotAI/kimi-code/pull/1419) [`5ea3ec4`](https://github.com/MoonshotAI/kimi-code/commit/5ea3ec489e0a7d66b844c39ee65162fd6a8ed8b1) Thanks [@liruifengv](https://github.com/liruifengv)! - Fix the Bash tool card collapsing in height when a multi-line command finishes with short output, and visually separate the command from its output.

- [#1410](https://github.com/MoonshotAI/kimi-code/pull/1410) [`1c817df`](https://github.com/MoonshotAI/kimi-code/commit/1c817df1e522f438d4392568b64fc039dc867031) Thanks [@liruifengv](https://github.com/liruifengv)! - Fix the edit approval preview shown by ctrl+e to include surrounding context lines, matching the summary panel.

- [#1421](https://github.com/MoonshotAI/kimi-code/pull/1421) [`1de0286`](https://github.com/MoonshotAI/kimi-code/commit/1de028612c80c38cd6fbe4483c123ded57a0a678) Thanks [@liruifengv](https://github.com/liruifengv)! - Fix the Edit tool card jumping in height and flickering while its result streams in.

- [#1389](https://github.com/MoonshotAI/kimi-code/pull/1389) [`ebdffc7`](https://github.com/MoonshotAI/kimi-code/commit/ebdffc7df7b89dcafcf62f5705eafb50bfbaf5ab) Thanks [@sailist](https://github.com/sailist)! - Fix tool calling with Google Gemini models, including Gemini 3 thinking-signature round-trips across turns.

- [#1393](https://github.com/MoonshotAI/kimi-code/pull/1393) [`4c43935`](https://github.com/MoonshotAI/kimi-code/commit/4c43935e31170140699a54cba631792872628655) Thanks [@justjavac](https://github.com/justjavac)! - web: Show the correct session search shortcut on Windows.

- [#1406](https://github.com/MoonshotAI/kimi-code/pull/1406) [`ce41f4b`](https://github.com/MoonshotAI/kimi-code/commit/ce41f4b58d128ae47b0312eab24a845bbc0d08a3) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Fix the collapsed sidebar not hiding and squeezing the conversation layout.

- [#1413](https://github.com/MoonshotAI/kimi-code/pull/1413) [`913d042`](https://github.com/MoonshotAI/kimi-code/commit/913d042208b4bfe45dc13144c4797dba1cac5d05) Thanks [@liruifengv](https://github.com/liruifengv)! - Fix the input box shifting upward after the slash command menu closes.

- [#1433](https://github.com/MoonshotAI/kimi-code/pull/1433) [`ac5b5e4`](https://github.com/MoonshotAI/kimi-code/commit/ac5b5e4cbfdb050817c9fce7e08dd3bdd8ea354e) Thanks [@liruifengv](https://github.com/liruifengv)! - web: Fix tool components jumping the conversation when expanded or collapsed.

- [#1394](https://github.com/MoonshotAI/kimi-code/pull/1394) [`e95fc83`](https://github.com/MoonshotAI/kimi-code/commit/e95fc83cc295dccf3e4c748fba087530dba614b6) Thanks [@justjavac](https://github.com/justjavac)! - web: Fix the font size setting so chat text, composer text, and sidebar text follow the selected size.

- [#1411](https://github.com/MoonshotAI/kimi-code/pull/1411) [`e6e6dd5`](https://github.com/MoonshotAI/kimi-code/commit/e6e6dd53ce9106f47684534a91acb1a803d1ab07) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Stop the chat history from replaying its entrance animation every time a session is opened.

- [#1409](https://github.com/MoonshotAI/kimi-code/pull/1409) [`578f7d3`](https://github.com/MoonshotAI/kimi-code/commit/578f7d334c7919e5987229c157060b1daae30139) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Fix the end of a reply staying missing after reopening a session.

- [#1390](https://github.com/MoonshotAI/kimi-code/pull/1390) [`083d0ca`](https://github.com/MoonshotAI/kimi-code/commit/083d0caf0524ed9cc7978007cd0f342f6bd2917e) Thanks [@sailist](https://github.com/sailist)! - Fix sessions that exist on disk but were missing from the session list or returned 404 on direct access, by rebuilding the session index at server startup and keeping it consistent.

- [#1357](https://github.com/MoonshotAI/kimi-code/pull/1357) [`be7c991`](https://github.com/MoonshotAI/kimi-code/commit/be7c9916b019b19e057301c39bc7944fcac09414) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Fix queued media messages not loading back into the composer and keep attachments when undoing a message.

- [#1428](https://github.com/MoonshotAI/kimi-code/pull/1428) [`903e8ed`](https://github.com/MoonshotAI/kimi-code/commit/903e8ed93afc5b35d0fa1d33c86da2b3fae9ba9f) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Add an Archived sessions entry to the mobile settings sheet and clarify the archive confirmation to mention restoring from Settings.

- [#1391](https://github.com/MoonshotAI/kimi-code/pull/1391) [`c5c6282`](https://github.com/MoonshotAI/kimi-code/commit/c5c6282f447dba202c79cf0e3b7524712d2c2748) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Render AskUserQuestion answers as a readable option list with the chosen option(s) highlighted, instead of raw JSON.

- [#1423](https://github.com/MoonshotAI/kimi-code/pull/1423) [`fa6d198`](https://github.com/MoonshotAI/kimi-code/commit/fa6d198b0174ad76aa4ca3c0ea2ed45e099e521b) Thanks [@liruifengv](https://github.com/liruifengv)! - web: Fix an almost-invisible composer input caret and a washed-out strikethrough on completed todos.

- [#1436](https://github.com/MoonshotAI/kimi-code/pull/1436) [`a5fbcb7`](https://github.com/MoonshotAI/kimi-code/commit/a5fbcb75b4b3ab937536a7a2f621c0374812c753) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Keep the composer toolbar from clipping its controls on narrow windows and phones, with the context ring staying visible at every width.

- [#1426](https://github.com/MoonshotAI/kimi-code/pull/1426) [`2374bc4`](https://github.com/MoonshotAI/kimi-code/commit/2374bc41c35adc1d2e2b5116559946c8de1b98a8) Thanks [@liruifengv](https://github.com/liruifengv)! - web: Show scheduled-reminder (cron) fires as notice cards in the chat instead of hiding them.

- [#1391](https://github.com/MoonshotAI/kimi-code/pull/1391) [`c5c6282`](https://github.com/MoonshotAI/kimi-code/commit/c5c6282f447dba202c79cf0e3b7524712d2c2748) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Align the markdown diff code block with the design system: code text keeps the normal ink colour while the sign and a soft row background carry the change, matching the ~/diff panel.

- [#1434](https://github.com/MoonshotAI/kimi-code/pull/1434) [`4aacddc`](https://github.com/MoonshotAI/kimi-code/commit/4aacddc43222d0a44f202360462617788ca75660) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Show the Kimi icon and clearer titles in web desktop notifications.

- [#1392](https://github.com/MoonshotAI/kimi-code/pull/1392) [`4963c90`](https://github.com/MoonshotAI/kimi-code/commit/4963c9016fa19d1e01f8dc938c8d250afec87965) Thanks [@sailist](https://github.com/sailist)! - web: Show available skills in the composer before a session is created.

- [#1438](https://github.com/MoonshotAI/kimi-code/pull/1438) [`d86fa38`](https://github.com/MoonshotAI/kimi-code/commit/d86fa38e119c5834fff13a67194efe8d62c117e1) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Prevent chat text from hyphenating at line breaks and render code without font ligatures.

- [#1391](https://github.com/MoonshotAI/kimi-code/pull/1391) [`c5c6282`](https://github.com/MoonshotAI/kimi-code/commit/c5c6282f447dba202c79cf0e3b7524712d2c2748) Thanks [@wbxl2000](https://github.com/wbxl2000)! - web: Drop the stray left indent in the tool-call card body so expanded content aligns with the header.

## 0.22.3

### Patch Changes

- [#1367](https://github.com/MoonshotAI/kimi-code/pull/1367) [`23daf0f`](https://github.com/MoonshotAI/kimi-code/commit/23daf0f3c199b4aaa9bd9388a2903d7827f98d32) - Revert the recent TUI transcript rendering changes to the original upstream behavior and fix related rendering issues.

- [#1343](https://github.com/MoonshotAI/kimi-code/pull/1343) [`ec758c7`](https://github.com/MoonshotAI/kimi-code/commit/ec758c747a95555847b8a0275ed0809010c7d5e7) - Add click-to-enlarge for images uploaded in the web chat. Click an image in a message to open it.

- [#1343](https://github.com/MoonshotAI/kimi-code/pull/1343) [`ec758c7`](https://github.com/MoonshotAI/kimi-code/commit/ec758c747a95555847b8a0275ed0809010c7d5e7) - Fix uploaded videos failing to play in the web chat.

- [#1371](https://github.com/MoonshotAI/kimi-code/pull/1371) [`5394fea`](https://github.com/MoonshotAI/kimi-code/commit/5394feaabb5d373fab046b3986b10a1180b4991d) - Wait for background subagents to finish and respond to their results before exiting in `kimi -p`, instead of ending the turn early.

- [#1373](https://github.com/MoonshotAI/kimi-code/pull/1373) [`e715b16`](https://github.com/MoonshotAI/kimi-code/commit/e715b1648c57bd0863edf859cb67db0327b7bb94) - Add `--dangerous-bypass-auth` and `--keep-alive` flags to `kimi server run`, so the server can run without a token on trusted networks and stay alive past the idle timeout.

- [#1344](https://github.com/MoonshotAI/kimi-code/pull/1344) [`26b9022`](https://github.com/MoonshotAI/kimi-code/commit/26b90225d21bd18f4f7e3b775f3f7f49034afad9) - Add a segmented thinking-level control in the web model picker for models that support multiple reasoning efforts. Open the composer model menu to choose a level.

## 0.22.2

### Patch Changes

- [#1353](https://github.com/MoonshotAI/kimi-code/pull/1353) [`68ad686`](https://github.com/MoonshotAI/kimi-code/commit/68ad686211760eb1c3e6b5c23eb28ace9009c17f) - Fix duplicated transcript content appearing in scrollback during streaming.

- [#1340](https://github.com/MoonshotAI/kimi-code/pull/1340) [`e2fe62a`](https://github.com/MoonshotAI/kimi-code/commit/e2fe62a5eff124b816a0f656355fc5bea85e3893) - Fix sessions silently dropping later user messages after a turn was interrupted between a tool call and its result.

- [#1342](https://github.com/MoonshotAI/kimi-code/pull/1342) [`84d8d5b`](https://github.com/MoonshotAI/kimi-code/commit/84d8d5b06399d29a9d8caba701835061c30a4817) - Have context-compaction notes capture a forward plan for the remaining work — upcoming steps, settled decisions, and foreseeable obstacles — instead of only the immediate next step, so the agent continues more coherently after auto-compaction.

- [#1340](https://github.com/MoonshotAI/kimi-code/pull/1340) [`e2fe62a`](https://github.com/MoonshotAI/kimi-code/commit/e2fe62a5eff124b816a0f656355fc5bea85e3893) - Fix requests being rejected by strict providers when the model emits duplicate tool call ids.

- [#1339](https://github.com/MoonshotAI/kimi-code/pull/1339) [`021786f`](https://github.com/MoonshotAI/kimi-code/commit/021786f5a201df5466a963d4d1ac915b3977582b) - Enrich PATH from the user's login shell at startup, so shell commands find user-installed tools (e.g. Homebrew's `gh`) even when kimi-code was launched without the full profile PATH.

- [#1336](https://github.com/MoonshotAI/kimi-code/pull/1336) [`4c1d0a1`](https://github.com/MoonshotAI/kimi-code/commit/4c1d0a1633c98ae5703addbf86ffe50b81545c08) - Keep automatic background updates from flashing a console window on Windows.

- [#1332](https://github.com/MoonshotAI/kimi-code/pull/1332) [`93f16c3`](https://github.com/MoonshotAI/kimi-code/commit/93f16c32d71d974f30c3ea3b1134691936ac5f53) - Fix `kimi upgrade` failing on Windows with a spawn error when installing the new version.

- [#1348](https://github.com/MoonshotAI/kimi-code/pull/1348) [`175b95f`](https://github.com/MoonshotAI/kimi-code/commit/175b95f3af684f7c5447967b9fe7c8a58b6ffe1b) - Fix compressed-image prompts leaking an internal `<system>` compression note into the visible message and the session title.

- [#1338](https://github.com/MoonshotAI/kimi-code/pull/1338) [`276407d`](https://github.com/MoonshotAI/kimi-code/commit/276407d2a46b03ce32cce02b73c5d485b1b02b17) - Promote the language-matching rule to a dedicated section in the system prompt, so replies and reasoning consistently follow the user's language through long English tool output, while repository artifacts keep project conventions.

- [#1347](https://github.com/MoonshotAI/kimi-code/pull/1347) [`02da587`](https://github.com/MoonshotAI/kimi-code/commit/02da5877953ce082826ba5ab1a1abd914d82b24a) - In `kimi -p` runs, wait for background subagents to finish before exiting when `background.keep_alive_on_exit` is enabled. Set `keep_alive_on_exit = true` to let concurrent background subagents complete.

- [#1349](https://github.com/MoonshotAI/kimi-code/pull/1349) [`e9db9ca`](https://github.com/MoonshotAI/kimi-code/commit/e9db9cafcf7a0d26122b2cac247d866d7724fd7a) - Record model response ids in session wire logs to make individual model requests easier to trace.

- [#1345](https://github.com/MoonshotAI/kimi-code/pull/1345) [`3ed22e3`](https://github.com/MoonshotAI/kimi-code/commit/3ed22e35a4ee09ce353e699406c6c994423ff39f) - Keep subagent cards at a stable height and show a live status spinner with a compact two-row activity window.

- [#1305](https://github.com/MoonshotAI/kimi-code/pull/1305) [`9091627`](https://github.com/MoonshotAI/kimi-code/commit/909162725770700efd3051f4cfa68156d9b84fa8) - Add a TUI preference to keep rapid multi-line pastes from submitting line by line when bracketed paste is unavailable. Set `disable_paste_burst = true` in `tui.toml` to turn it off.

- [#1328](https://github.com/MoonshotAI/kimi-code/pull/1328) [`01b65bd`](https://github.com/MoonshotAI/kimi-code/commit/01b65bdddc28c7c492096000103687f6a507e353) - Rebuild the web design-system easter egg as an in-app overlay that uses the app's real design tokens, so it stays in sync instead of drifting as a separate copy.

## 0.22.1

### Patch Changes

- [#1304](https://github.com/MoonshotAI/kimi-code/pull/1304) [`0fc0ae3`](https://github.com/MoonshotAI/kimi-code/commit/0fc0ae380b09aa96aad0eff1ae66f239e061d01a) - When large images are compressed, tell the model the original and delivered image details. Keep the original image available, and support cropped or full-resolution reads for fine details.

- [#1315](https://github.com/MoonshotAI/kimi-code/pull/1315) [`b40bb71`](https://github.com/MoonshotAI/kimi-code/commit/b40bb7139939eb2ba734ce5dd4871b894d7033e8) - Fix TUI rendering bugs that caused the screen to go blank and the input box to disappear.

- [#1303](https://github.com/MoonshotAI/kimi-code/pull/1303) [`2639786`](https://github.com/MoonshotAI/kimi-code/commit/2639786ce578f15c020a2c11c344797dae18de61) - Fix the TUI crashing when the terminal is resized to a very narrow width while the input contains CJK or emoji text.

- [#1315](https://github.com/MoonshotAI/kimi-code/pull/1315) [`b40bb71`](https://github.com/MoonshotAI/kimi-code/commit/b40bb7139939eb2ba734ce5dd4871b894d7033e8) - Clear the screen fully when starting a new session via /new, /clear, or a session switch.

- [#1301](https://github.com/MoonshotAI/kimi-code/pull/1301) [`c3653a1`](https://github.com/MoonshotAI/kimi-code/commit/c3653a1c50ffa3856484599e132980628eb9fca4) - Show an up arrow on the web composer send button.

- [#1290](https://github.com/MoonshotAI/kimi-code/pull/1290) [`3ea84a5`](https://github.com/MoonshotAI/kimi-code/commit/3ea84a56e4dfdeaddd58add5b269be0342f3f986) - Fix the session search dialog showing a horizontal scrollbar for long session titles or snippets.

- [#1316](https://github.com/MoonshotAI/kimi-code/pull/1316) [`5322c63`](https://github.com/MoonshotAI/kimi-code/commit/5322c638895a934c1ce220fefed54f5077d2a49e) - Fix web tooltips that could get stuck on screen when their trigger element is removed while open.

- [#1319](https://github.com/MoonshotAI/kimi-code/pull/1319) [`e8ab7ca`](https://github.com/MoonshotAI/kimi-code/commit/e8ab7ca78661de7f00a8196444be1db93e7c14b4) - Fix the sidebar session row shifting its title and status badges when hovered.

- [#1293](https://github.com/MoonshotAI/kimi-code/pull/1293) [`6a469b3`](https://github.com/MoonshotAI/kimi-code/commit/6a469b3e07022e56b29b1fd8a7c58df36b2111fe) - Refresh the web UI icon set and unify the message copy and undo button hover states and tooltips.

- [#1311](https://github.com/MoonshotAI/kimi-code/pull/1311) [`b40649b`](https://github.com/MoonshotAI/kimi-code/commit/b40649b2ae7a4b6a0aea04e32eba200555393064) - Remove duplicate newline-shortcut handling from the prompt editor.

- [#1317](https://github.com/MoonshotAI/kimi-code/pull/1317) [`78a058a`](https://github.com/MoonshotAI/kimi-code/commit/78a058acd2fc91de5cca0c1d66d415ee35884889) - Remove the experimental micro compaction feature and its toggle from the experiments panel.

- [#1283](https://github.com/MoonshotAI/kimi-code/pull/1283) [`ea55911`](https://github.com/MoonshotAI/kimi-code/commit/ea55911062eefcb0414cfddb84c8a4494c45f363) - Improve compaction handoff summaries for more reliable resumed sessions. They now keep the latest intent, key tool results, decisions, open questions, and context to re-check.

- [#1295](https://github.com/MoonshotAI/kimi-code/pull/1295) [`77eb3a9`](https://github.com/MoonshotAI/kimi-code/commit/77eb3a9fe40c93fa32e335f07160b8128355bab6) - Save shell commands to input history and recall them in bash mode. Press Up on an empty `!` prompt to browse previous shell commands.

- [#1316](https://github.com/MoonshotAI/kimi-code/pull/1316) [`5322c63`](https://github.com/MoonshotAI/kimi-code/commit/5322c638895a934c1ce220fefed54f5077d2a49e) - Trim redundant and incorrect tooltips in the web UI.

- [#1320](https://github.com/MoonshotAI/kimi-code/pull/1320) [`444e6b1`](https://github.com/MoonshotAI/kimi-code/commit/444e6b15f0e53b6c4d75d1bfdc0b35639dce6f4c) - Fix the web UI becoming sluggish after opening many sessions.

- [#1322](https://github.com/MoonshotAI/kimi-code/pull/1322) [`5441ad1`](https://github.com/MoonshotAI/kimi-code/commit/5441ad1838a5cfa1f3df0ca2ee1524e1433fb513) - Let the web sidebar collapse an expanded workspace session list back to its first page.

## 0.22.0

### Minor Changes

- [#1243](https://github.com/MoonshotAI/kimi-code/pull/1243) [`ace7901`](https://github.com/MoonshotAI/kimi-code/commit/ace79010669d19ad175bc25443b6efb41ca2e2ac) - Automatically compress oversized images before they reach the model. Whatever the source — pasted into the CLI, uploaded from the web/desktop client, sent over ACP, read via `ReadMediaFile`, or returned by an MCP tool — images are downsampled (longest edge ≤ 2000px) and re-encoded to fit a per-image byte budget, cutting vision-token cost and avoiding provider image-size errors. Screenshots stay lossless PNG and only degrade to JPEG when the byte budget cannot otherwise be met. Compression runs as an input-stage step at each ingestion point (while the content part is built), and guards against decompression bombs by skipping absurdly large pixel/byte payloads before decoding. Best-effort: if it fails for any reason the original image is sent unchanged.

- [#1262](https://github.com/MoonshotAI/kimi-code/pull/1262) [`c070fbe`](https://github.com/MoonshotAI/kimi-code/commit/c070fbeddeb1c147d8859a76046f9465f696c9cb) - Add model alias overrides so manual thinking effort levels and model metadata survive provider catalog refreshes. Set them under `[models."<alias>".overrides]`.

- [#1258](https://github.com/MoonshotAI/kimi-code/pull/1258) [`b905dd4`](https://github.com/MoonshotAI/kimi-code/commit/b905dd49108c567d0fecd38a096808c121672795) - Refresh the web UI with a new design system, including updated colors, typography, spacing, light and dark palettes, restyled tooltips, and subtle enter/exit and expand/collapse animations.

### Patch Changes

- [#1258](https://github.com/MoonshotAI/kimi-code/pull/1258) [`b905dd4`](https://github.com/MoonshotAI/kimi-code/commit/b905dd49108c567d0fecd38a096808c121672795) - Show draft pull requests with a distinct draft status instead of displaying them as open.

- [#1254](https://github.com/MoonshotAI/kimi-code/pull/1254) [`7859b0a`](https://github.com/MoonshotAI/kimi-code/commit/7859b0afe8898852806e5a0c21b9dd52cb82f834) - Fix the transcript jumping to the top when scrolling up through history during streaming output.

- [#1258](https://github.com/MoonshotAI/kimi-code/pull/1258) [`b905dd4`](https://github.com/MoonshotAI/kimi-code/commit/b905dd49108c567d0fecd38a096808c121672795) - Fix plan, swarm, and goal modes being shared across sessions in the web UI; each session now keeps its own toggles.

- [#1264](https://github.com/MoonshotAI/kimi-code/pull/1264) [`003733c`](https://github.com/MoonshotAI/kimi-code/commit/003733c751584ce30d8ebae4f5e608f0df049d32) - Hide the unsupported Off option in the /model thinking switcher for always-on models that already expose multiple effort levels.

- [#1272](https://github.com/MoonshotAI/kimi-code/pull/1272) [`54703d9`](https://github.com/MoonshotAI/kimi-code/commit/54703d9457dcda7bc782301fc2dbb41a2c8d7293) - Release pasted images and streaming timers once they are no longer shown, so memory stops growing in long sessions.

- [#1272](https://github.com/MoonshotAI/kimi-code/pull/1272) [`54703d9`](https://github.com/MoonshotAI/kimi-code/commit/54703d9457dcda7bc782301fc2dbb41a2c8d7293) - Fix the terminal being left in raw mode with a hidden cursor and disabled flow control after a crash or abrupt exit.

- [#1265](https://github.com/MoonshotAI/kimi-code/pull/1265) [`8cfb165`](https://github.com/MoonshotAI/kimi-code/commit/8cfb1657ad7bf525269df4ab6cf5c12aa1d406a9) - Reduce the default TUI transcript window to keep long sessions responsive.

- [#1258](https://github.com/MoonshotAI/kimi-code/pull/1258) [`b905dd4`](https://github.com/MoonshotAI/kimi-code/commit/b905dd49108c567d0fecd38a096808c121672795) - Replace the Explore and Native theme options with a single chat layout and a Blue or Black accent-color setting.

- [#1258](https://github.com/MoonshotAI/kimi-code/pull/1258) [`b905dd4`](https://github.com/MoonshotAI/kimi-code/commit/b905dd49108c567d0fecd38a096808c121672795) - Show time, duration, connection, and stack details in web error and warning toasts.

- [#1258](https://github.com/MoonshotAI/kimi-code/pull/1258) [`b905dd4`](https://github.com/MoonshotAI/kimi-code/commit/b905dd49108c567d0fecd38a096808c121672795) - Fix an active workspace showing only its five most recent sessions on load, so it now keeps loading older sessions from the last 12 hours.

- [#1258](https://github.com/MoonshotAI/kimi-code/pull/1258) [`b905dd4`](https://github.com/MoonshotAI/kimi-code/commit/b905dd49108c567d0fecd38a096808c121672795) - Reduce the web composer's default height for a more compact empty state, and fix ArrowUp recalling the previous message while editing a multi-line draft; ArrowUp now recalls only from the very start of the text and is disabled in the expanded editor.

- [#1258](https://github.com/MoonshotAI/kimi-code/pull/1258) [`b905dd4`](https://github.com/MoonshotAI/kimi-code/commit/b905dd49108c567d0fecd38a096808c121672795) - Fix the Thinking-by-default setting not taking effect, so new sessions correctly start with thinking enabled.

- [#1258](https://github.com/MoonshotAI/kimi-code/pull/1258) [`b905dd4`](https://github.com/MoonshotAI/kimi-code/commit/b905dd49108c567d0fecd38a096808c121672795) - Fix spurious errors from the web question, approval, and task actions when the action was already complete, and add loading feedback so each click is acknowledged immediately.

- [#1258](https://github.com/MoonshotAI/kimi-code/pull/1258) [`b905dd4`](https://github.com/MoonshotAI/kimi-code/commit/b905dd49108c567d0fecd38a096808c121672795) - Show queued prompts inline below the running turn in the web chat, and split Stop into its own button so Send no longer interrupts.

- [#1278](https://github.com/MoonshotAI/kimi-code/pull/1278) [`bbda90a`](https://github.com/MoonshotAI/kimi-code/commit/bbda90af846ca66232158d2e9605d3d59a7e3a49) - Hide the conversation outline when there is not enough room to expand its labels, so it no longer clips against the window edge.

- [#1258](https://github.com/MoonshotAI/kimi-code/pull/1258) [`b905dd4`](https://github.com/MoonshotAI/kimi-code/commit/b905dd49108c567d0fecd38a096808c121672795) - Show the conversation outline as one entry per user query that expands into a labeled list on hover.

- [#1258](https://github.com/MoonshotAI/kimi-code/pull/1258) [`b905dd4`](https://github.com/MoonshotAI/kimi-code/commit/b905dd49108c567d0fecd38a096808c121672795) - Remove the fade-out animation when undoing a message in the web chat.

- [#1258](https://github.com/MoonshotAI/kimi-code/pull/1258) [`b905dd4`](https://github.com/MoonshotAI/kimi-code/commit/b905dd49108c567d0fecd38a096808c121672795) - Improve session search with a Cmd/Ctrl+K palette that filters by title, workspace, and last prompt with highlighted matches. Press Cmd+K or Ctrl+K to open it.

- [#1258](https://github.com/MoonshotAI/kimi-code/pull/1258) [`b905dd4`](https://github.com/MoonshotAI/kimi-code/commit/b905dd49108c567d0fecd38a096808c121672795) - Group consecutive tool calls into a collapsible stack with per-tool renderers, including diff line-count chips for edits and inline previews for image, video, and audio results.

- [#1258](https://github.com/MoonshotAI/kimi-code/pull/1258) [`b905dd4`](https://github.com/MoonshotAI/kimi-code/commit/b905dd49108c567d0fecd38a096808c121672795) - Use one consistent modal dialog for confirmations in the web UI (archive session, delete workspace, delete provider, undo message, and mode toggles).

- [#1258](https://github.com/MoonshotAI/kimi-code/pull/1258) [`b905dd4`](https://github.com/MoonshotAI/kimi-code/commit/b905dd49108c567d0fecd38a096808c121672795) - Add workspace sorting by manual order or last-edited time, plus collapse-all and expand-all controls, to the sidebar.

## 0.21.1

### Patch Changes

- [#1256](https://github.com/MoonshotAI/kimi-code/pull/1256) [`0cc02ac`](https://github.com/MoonshotAI/kimi-code/commit/0cc02ac67d465d1d4d7fe070422bab17053cdaa3) - Keep the waiting spinner visible while encrypted reasoning streams, fixing a blank spinner-less gap before the first response text appears.

## 0.21.0

### Minor Changes

- [#1204](https://github.com/MoonshotAI/kimi-code/pull/1204) [`5cb80ce`](https://github.com/MoonshotAI/kimi-code/commit/5cb80ce879406d239048c32d61202778cb860e58) - Plugins can now provide slash commands via a `commands` field in their manifest, registered as `<plugin>:<command>` and invoked with `$ARGUMENTS` expansion.

- [#1214](https://github.com/MoonshotAI/kimi-code/pull/1214) [`86e0c92`](https://github.com/MoonshotAI/kimi-code/commit/86e0c9201ed58c7c1ce5543b1dfb47a4cf5117f6) - Rework conversation compaction:

  - Keep only recent user prompts plus a single user-role summary; drop assistant and tool messages.
  - Repair tool_use/tool_result adjacency before sending, fixing a strict-provider HTTP 400 when a tool call and its result became non-adjacent.
  - Merge consecutive user turns for strict providers (Gemini/Vertex), fixing an HTTP 400 ("roles must alternate") after compaction or when a turn is steered in right after a tool result.
  - Micro-compaction now defaults off.

- [#1132](https://github.com/MoonshotAI/kimi-code/pull/1132) [`108299b`](https://github.com/MoonshotAI/kimi-code/commit/108299be3cdffc31a23f64efd3ff5ba50976b412) - Refactor the thinking effort system

### Patch Changes

- [#1231](https://github.com/MoonshotAI/kimi-code/pull/1231) [`ceb27f5`](https://github.com/MoonshotAI/kimi-code/commit/ceb27f5e449e177493f320d90e292487a8fc3410) - Add a server-side key-value store API for persisting web UI preferences to the user's data directory.

- [#1220](https://github.com/MoonshotAI/kimi-code/pull/1220) [`ec51324`](https://github.com/MoonshotAI/kimi-code/commit/ec51324230484f2ebaad1ab0aebf2e38f531d914) - Add a double-Esc shortcut to open the undo selector. Press Esc twice while idle to undo.

- [#1223](https://github.com/MoonshotAI/kimi-code/pull/1223) [`80e6888`](https://github.com/MoonshotAI/kimi-code/commit/80e6888e34e4362247c0eac5b77340df014ba286) - Fix @ file mentions not opening when typed inside a slash command argument.

- [#1233](https://github.com/MoonshotAI/kimi-code/pull/1233) [`020992c`](https://github.com/MoonshotAI/kimi-code/commit/020992c286f0f6bff6a038a7c7bd7e9db639e3c9) - Force-exit headless runs (`kimi -p`) so a stray ref'd handle left over from the run can't keep a completed run alive until an external timeout, and bound prompt cleanup so a wedged shutdown step can't hang shutdown.

- [#1225](https://github.com/MoonshotAI/kimi-code/pull/1225) [`659062d`](https://github.com/MoonshotAI/kimi-code/commit/659062d11cc272fe631fc6d4faf64d0e0b1a0142) - Show file path completions when typing `/` in shell mode (`!`).

- [#1236](https://github.com/MoonshotAI/kimi-code/pull/1236) [`bfe8e6a`](https://github.com/MoonshotAI/kimi-code/commit/bfe8e6ace3cda76b1991bf29c25b9444611d5512) - Fix adding a workspace by path in the web UI failing silently when the daemon rejects the path; it now shows an error instead of a broken workspace.

- [#1221](https://github.com/MoonshotAI/kimi-code/pull/1221) [`a3f9cec`](https://github.com/MoonshotAI/kimi-code/commit/a3f9cec8a975f11e37e992e42f954789ed394207) - Fix duplicate workspaces showing in the web sidebar when the same folder is registered more than once.

- [#1241](https://github.com/MoonshotAI/kimi-code/pull/1241) [`8ac337a`](https://github.com/MoonshotAI/kimi-code/commit/8ac337a2b2ac800aa79a373459308abb6c9e63bb) - Stop a malformed message history from permanently bricking a session on strict providers (Anthropic). The request is repaired before sending — orphaned tool calls are closed and empty/whitespace-only text blocks dropped — and if the provider still rejects its structure, it is resent once with a wire-compliant rebuild.

- [#1228](https://github.com/MoonshotAI/kimi-code/pull/1228) [`42e37eb`](https://github.com/MoonshotAI/kimi-code/commit/42e37eb898b722829d2ec83e909525ff18e336a5) - Split LLM streaming timing in the session log and `KIMI_CODE_DEBUG=1` output into client vs. API-server portions, so slow turns can be attributed without parsing the wire log. Time-to-first-token splits into the API-server portion (network + server) and the client portion (in-process request building); the decode window splits into time awaiting tokens from the server and time the client spends processing each streamed chunk.

- [#1234](https://github.com/MoonshotAI/kimi-code/pull/1234) [`882cf35`](https://github.com/MoonshotAI/kimi-code/commit/882cf355a9cb45bb5b3424a27b953bde8e106bb0) - Hide the provider management dialog in the web UI until the server supports it.

- [#1226](https://github.com/MoonshotAI/kimi-code/pull/1226) [`7f05f58`](https://github.com/MoonshotAI/kimi-code/commit/7f05f589e7bc77a2f26463a41317ff7087e3c3a0) - Add Mermaid diagram rendering to the web chat. Fenced `mermaid` blocks in assistant responses now render as diagrams. KaTeX math and Mermaid diagram parsing also run in Web Workers to keep the UI responsive during live streaming.

- [#1232](https://github.com/MoonshotAI/kimi-code/pull/1232) [`aa6b0d0`](https://github.com/MoonshotAI/kimi-code/commit/aa6b0d065ee888056c3812781483ddb74739897f) - Always show the usage-data opt-out toggle in the web settings with a clearer label and description.

- [#1234](https://github.com/MoonshotAI/kimi-code/pull/1234) [`882cf35`](https://github.com/MoonshotAI/kimi-code/commit/882cf355a9cb45bb5b3424a27b953bde8e106bb0) - Fix the web workspace rename not persisting after a page refresh.

## 0.20.3

### Patch Changes

- [#1207](https://github.com/MoonshotAI/kimi-code/pull/1207) [`14d9e98`](https://github.com/MoonshotAI/kimi-code/commit/14d9e98903f30f83199e30b5fa20b3c61ab28781) - Refresh provider model lists automatically in the background instead of only at startup, so newly available models appear without restarting.

- [#1191](https://github.com/MoonshotAI/kimi-code/pull/1191) [`0df1812`](https://github.com/MoonshotAI/kimi-code/commit/0df18125022103dabb149b4f26f90959b669187b) - Fix provider error messages rendering as blank lines in the TUI when the server returns an HTML error page.

- [#1212](https://github.com/MoonshotAI/kimi-code/pull/1212) [`636ccc4`](https://github.com/MoonshotAI/kimi-code/commit/636ccc40f19f259bdd6653b2ca563a75b3548e23) - Fix the web composer being hidden behind the mobile Safari toolbar and the page auto-zooming when the composer is focused.

- [#1068](https://github.com/MoonshotAI/kimi-code/pull/1068) [`c82dcf9`](https://github.com/MoonshotAI/kimi-code/commit/c82dcf9cd8276eddf6acbf1030d1712b83a38083) - Glob now uses ripgrep, so it respects .gitignore by default, supports brace patterns, returns only files, and keeps partial results with a warning when some directories are unreadable.

- [#1209](https://github.com/MoonshotAI/kimi-code/pull/1209) [`0635387`](https://github.com/MoonshotAI/kimi-code/commit/063538744f64a1bd3da6f37ebd0643d10bfc068f) - Align malformed tool call argument handling with schema validation fallback.

## 0.20.2

### Patch Changes

- [#1166](https://github.com/MoonshotAI/kimi-code/pull/1166) [`dfcfdfd`](https://github.com/MoonshotAI/kimi-code/commit/dfcfdfd9ddbe14fb6e358694394e1ddcc21b8911) - Add an optional exclude_empty parameter to the session list API to omit sessions that have no messages.

- [#1156](https://github.com/MoonshotAI/kimi-code/pull/1156) [`794db55`](https://github.com/MoonshotAI/kimi-code/commit/794db55538e01b4bf0c008c493de5d8b8bf67c5d) - Cap compaction output at 128k tokens by default to avoid provider max_tokens errors.

- [#1129](https://github.com/MoonshotAI/kimi-code/pull/1129) [`d02b5c4`](https://github.com/MoonshotAI/kimi-code/commit/d02b5c49844d65e005632fafcb1c172a7d32bfbe) - Fix compaction ignoring the configured max output size.

- [#1188](https://github.com/MoonshotAI/kimi-code/pull/1188) [`db5fbc5`](https://github.com/MoonshotAI/kimi-code/commit/db5fbc53c00c9945fc1fa98c69c4e5c7efb8077e) - Fix unnecessary full-screen redraws when typing in the input box or toggling the slash panel.

- [#1187](https://github.com/MoonshotAI/kimi-code/pull/1187) [`97f9263`](https://github.com/MoonshotAI/kimi-code/commit/97f9263c6f13ead5edc051f96993f8d1d7d5ec6f) - Fix debug timing output lingering after undoing a turn.

- [#1163](https://github.com/MoonshotAI/kimi-code/pull/1163) [`ff6e8bb`](https://github.com/MoonshotAI/kimi-code/commit/ff6e8bbd7c328dcc6575902cfd0cb3e522f20948) - Fix the web composer occasionally keeping typed text after sending the first message of a new session.

- [#1189](https://github.com/MoonshotAI/kimi-code/pull/1189) [`04b3492`](https://github.com/MoonshotAI/kimi-code/commit/04b3492e740dad5fca2af9f66eca98da3e14058a) - Fix working tips getting squeezed against the agent swarm progress bar.

- [#1159](https://github.com/MoonshotAI/kimi-code/pull/1159) [`23a553b`](https://github.com/MoonshotAI/kimi-code/commit/23a553bb91e9ee794aaf769f78f5acec739aec85) - In the bundled web UI, `/new` and `/clear` are now aliases that open the session onboarding composer and focus the input. iOS auto-zoom is prevented by keeping text inputs at 16px instead of disabling viewport scaling.

- [#1186](https://github.com/MoonshotAI/kimi-code/pull/1186) [`821847c`](https://github.com/MoonshotAI/kimi-code/commit/821847cb4b88d9128014609aad307ab8d9e9a5f3) - Add `KIMI_CODE_CUSTOM_HEADERS` for custom outbound LLM request headers and send the `User-Agent` header to non-Kimi providers. Set `KIMI_CODE_CUSTOM_HEADERS` to newline-separated `Name: Value` lines.

- [#1186](https://github.com/MoonshotAI/kimi-code/pull/1186) [`821847c`](https://github.com/MoonshotAI/kimi-code/commit/821847cb4b88d9128014609aad307ab8d9e9a5f3) - Route managed Kimi Code models on the Anthropic-compatible protocol through the beta Messages API.

- [#1170](https://github.com/MoonshotAI/kimi-code/pull/1170) [`cf558cd`](https://github.com/MoonshotAI/kimi-code/commit/cf558cd74267393d6497ddedf25e192eaac4f94b) - Recover from provider 413 context overflows by compacting before retrying.

- [#1170](https://github.com/MoonshotAI/kimi-code/pull/1170) [`cf558cd`](https://github.com/MoonshotAI/kimi-code/commit/cf558cd74267393d6497ddedf25e192eaac4f94b) - Support the Anthropic-compatible protocol for managed Kimi Code, including video input.

- [#1186](https://github.com/MoonshotAI/kimi-code/pull/1186) [`821847c`](https://github.com/MoonshotAI/kimi-code/commit/821847cb4b88d9128014609aad307ab8d9e9a5f3) - Add provider type and protocol attributes to turn and API error telemetry.

- [#1155](https://github.com/MoonshotAI/kimi-code/pull/1155) [`54baf5d`](https://github.com/MoonshotAI/kimi-code/commit/54baf5d07fe718b70b8840e509a905ac48b1ccac) - Upgrade web markdown renderer dependencies (katex, markstream-vue, shiki) for bug fixes and performance improvements.

- [#1162](https://github.com/MoonshotAI/kimi-code/pull/1162) [`b070846`](https://github.com/MoonshotAI/kimi-code/commit/b0708464f4160f7b73f25a520e493bf87e92149f) - Rework the web ask-user-question card into a step-by-step wizard so multi-question navigation and the final Submit action are easier to see.

- [#1179](https://github.com/MoonshotAI/kimi-code/pull/1179) [`fc3d69d`](https://github.com/MoonshotAI/kimi-code/commit/fc3d69dbdc965e525b5486a6b91e4ec44194ca97) - Add a completion sound and question notifications to the web UI, with separate Settings toggles for completion notifications, question notifications, and sound. Question notifications default off so question text only reaches your desktop after you opt in.

- [#1165](https://github.com/MoonshotAI/kimi-code/pull/1165) [`f3b1532`](https://github.com/MoonshotAI/kimi-code/commit/f3b15322da518b0e3d0560d19651435793c790d9) - Replace the web composer attach button's plus icon with an image icon.

- [#1167](https://github.com/MoonshotAI/kimi-code/pull/1167) [`c63edd5`](https://github.com/MoonshotAI/kimi-code/commit/c63edd5bf6d764c3ab771cb697a334ac100a0944) - In the bundled web UI, a new session is now created only when the first message is sent, so + New without a workspace opens the composer instead of making an empty session.

- [#1166](https://github.com/MoonshotAI/kimi-code/pull/1166) [`dfcfdfd`](https://github.com/MoonshotAI/kimi-code/commit/dfcfdfd9ddbe14fb6e358694394e1ddcc21b8911) - Hide unused "New Session" entries from the web session list by default.

- [#1181](https://github.com/MoonshotAI/kimi-code/pull/1181) [`1dab2c2`](https://github.com/MoonshotAI/kimi-code/commit/1dab2c2268af6f74464b6573981c1e1bb4bda703) - Restore each session's scroll position when switching back to it in the web UI.

- [#1181](https://github.com/MoonshotAI/kimi-code/pull/1181) [`1dab2c2`](https://github.com/MoonshotAI/kimi-code/commit/1dab2c2268af6f74464b6573981c1e1bb4bda703) - Keep the open side panel when switching between sessions in the web UI.

- [#1166](https://github.com/MoonshotAI/kimi-code/pull/1166) [`dfcfdfd`](https://github.com/MoonshotAI/kimi-code/commit/dfcfdfd9ddbe14fb6e358694394e1ddcc21b8911) - Remove the /sessions slash command from the web UI; the sidebar already covers session browsing.

- [#1181](https://github.com/MoonshotAI/kimi-code/pull/1181) [`1dab2c2`](https://github.com/MoonshotAI/kimi-code/commit/1dab2c2268af6f74464b6573981c1e1bb4bda703) - Keep unsent composer attachments scoped to their session in the web UI, so switching sessions no longer leaks them into another session's next message.

- [#1161](https://github.com/MoonshotAI/kimi-code/pull/1161) [`d968642`](https://github.com/MoonshotAI/kimi-code/commit/d968642384f672295756394ee07a536dbfdb4dfd) - Show the first five sessions per workspace in the web sidebar instead of ten.

- [#1181](https://github.com/MoonshotAI/kimi-code/pull/1181) [`1dab2c2`](https://github.com/MoonshotAI/kimi-code/commit/1dab2c2268af6f74464b6573981c1e1bb4bda703) - Scope the web composer's up/down input history to the current session instead of sharing it across all sessions.

## 0.20.1

### Patch Changes

- [#1125](https://github.com/MoonshotAI/kimi-code/pull/1125) [`e9a3b7c`](https://github.com/MoonshotAI/kimi-code/commit/e9a3b7c83a623c7323da509ba885567c465093fc) - Add an `update` alias for the `kimi upgrade` command. Run `kimi update` to upgrade to the latest version.

- [#1122](https://github.com/MoonshotAI/kimi-code/pull/1122) [`820d77a`](https://github.com/MoonshotAI/kimi-code/commit/820d77ab4cfad7752358a4692fd3d7def49f005d) - Show the done / in progress / pending breakdown of hidden todos in the collapsed todo panel.

- [#1131](https://github.com/MoonshotAI/kimi-code/pull/1131) [`76c643b`](https://github.com/MoonshotAI/kimi-code/commit/76c643bcb6da447c8c47728b4f58512a7a11cfa6) - Cap completion tokens to the remaining context window for chat-completions providers, avoiding context-overflow and invalid max_tokens errors.

- [#1120](https://github.com/MoonshotAI/kimi-code/pull/1120) [`e736349`](https://github.com/MoonshotAI/kimi-code/commit/e736349a7c8ff55b73e05cc0192dfaf0114745fa) - Add optional feedback attachments for diagnostic logs and codebase context.

- [#1135](https://github.com/MoonshotAI/kimi-code/pull/1135) [`bf51fb7`](https://github.com/MoonshotAI/kimi-code/commit/bf51fb7a105b2f34a59ed4e83d2588e790cfb086) - Fix the local server failing to start on Windows after the first run because the persistent token file's synthesized mode was rejected as too permissive.

- [#1102](https://github.com/MoonshotAI/kimi-code/pull/1102) [`9c97161`](https://github.com/MoonshotAI/kimi-code/commit/9c9716125e104b217540d0591229d03c6d676ead) - Harden the default system prompt and built-in tool descriptions: stop the agent from blocking on background tasks it should let run, keep its guidance matched to the tools each profile actually provides, and surface tool-result details (fetched-page mode, Grep match totals) it previously missed.

- [#1127](https://github.com/MoonshotAI/kimi-code/pull/1127) [`184acf5`](https://github.com/MoonshotAI/kimi-code/commit/184acf5db521a964a8af9dfdb1502121a9be76dc) - Plugins can now declare hooks in their manifest to run scripts on lifecycle events.

- [#1128](https://github.com/MoonshotAI/kimi-code/pull/1128) [`0886bff`](https://github.com/MoonshotAI/kimi-code/commit/0886bff2bcd3aed954990c948201d84787c0f3f3) - Add a --allowed-host flag to kimi server run that lets extra Host header values pass the DNS-rebinding check, and include allow guidance in the 403 error message. Pass --allowed-host <host> to allow an extra host.

- [#1119](https://github.com/MoonshotAI/kimi-code/pull/1119) [`b0b2aee`](https://github.com/MoonshotAI/kimi-code/commit/b0b2aee8c5a496c2b679fc9dbbc05e3d1934d5d9) - Keep the terminal responsive in long conversations by caching rendered message lines.

- [#1119](https://github.com/MoonshotAI/kimi-code/pull/1119) [`b0b2aee`](https://github.com/MoonshotAI/kimi-code/commit/b0b2aee8c5a496c2b679fc9dbbc05e3d1934d5d9) - Keep long sessions responsive by retaining only recent turns in the transcript and collapsing older steps within each turn.

- [#1121](https://github.com/MoonshotAI/kimi-code/pull/1121) [`81ba48f`](https://github.com/MoonshotAI/kimi-code/commit/81ba48f45534e133947c4e5e78907c2ad0db0b90) - Make the web chat input grow with its content and add an expandable editor for longer messages.

- [#1133](https://github.com/MoonshotAI/kimi-code/pull/1133) [`f1c8175`](https://github.com/MoonshotAI/kimi-code/commit/f1c8175f9c5766f6a928fd07fb680e3159c564b0) - Fix the /web slash command not carrying the server token, so the opened web UI signs in automatically and the token is shown before the terminal exits.

## 0.20.0

### Minor Changes

- [#1079](https://github.com/MoonshotAI/kimi-code/pull/1079) [`2db5fc2`](https://github.com/MoonshotAI/kimi-code/commit/2db5fc20ecdf3212afd47e7c26195e428f8eddd5) - Add shell mode for running shell commands.
  Type `!` in the input box to enable it.
  The command output is visible to the AI.
  For long-running commands, press Ctrl+B to move them to the background.
  For example, you can run `!gh auth login` to sign in to the GitHub CLI without opening a new terminal, so Kimi can use `gh`.

- [#1088](https://github.com/MoonshotAI/kimi-code/pull/1088) [`0030f76`](https://github.com/MoonshotAI/kimi-code/commit/0030f76c5cc6465c5a6646c166375127d83696d3) - Add a confirmation prompt before installing third-party plugins.

- [#1066](https://github.com/MoonshotAI/kimi-code/pull/1066) [`3554f7e`](https://github.com/MoonshotAI/kimi-code/commit/3554f7e7d6e472413aa7a9873d7a2eef5f2b819c) - Show update badges on the /plugins Installed tab, where Enter now installs the available update and I opens plugin details.

- [#1025](https://github.com/MoonshotAI/kimi-code/pull/1025) [`5ef66dd`](https://github.com/MoonshotAI/kimi-code/commit/5ef66ddfeda2f23c40fc0cf53225cdaf3cc1147d) - Redesign `/plugins` as a single tabbed panel: **Installed** (manage installed
  plugins — toggle, remove, MCP, details, reload), **Official** (Kimi-maintained
  marketplace plugins), **Third-party** (marketplace plugins from other
  publishers), and **Custom** (install straight from a GitHub URL, zip URL, or
  local path). `Tab` / `Shift-Tab` switch tabs. The Official and Third-party
  catalogs load lazily, so `/plugins` opens instantly and keeps working offline —
  a marketplace fetch failure is shown inline instead of closing the panel. The
  tab strip is shared with the `/model` provider tabs via the new `renderTabStrip`
  helper.

- [#1006](https://github.com/MoonshotAI/kimi-code/pull/1006) [`60dfb68`](https://github.com/MoonshotAI/kimi-code/commit/60dfb68a2d4c342cfbad5f48d4d269fb6cdd43c0) - Add server authentication and safe `--host` exposure. The local server now
  requires a per-start bearer token on all API and WebSocket calls (the CLI reads
  it automatically), enforces Host/Origin checks, and gains `--host` with a
  public-binding hardening tier: mandatory `KIMI_CODE_PASSWORD`, TLS (or
  `--insecure-no-tls`), auth-failure rate limiting, disabled remote
  shutdown/terminals, and security response headers. See `packages/server/SECURITY.md`.

- [#1040](https://github.com/MoonshotAI/kimi-code/pull/1040) [`6664038`](https://github.com/MoonshotAI/kimi-code/commit/66640380ebf60141994986beadf5347617f82814) - Replace silent AGENTS.md truncation with a visible warning in the TUI status bar and web UI.

- [#1101](https://github.com/MoonshotAI/kimi-code/pull/1101) [`3ea6ac2`](https://github.com/MoonshotAI/kimi-code/commit/3ea6ac278d2e57bb859ab423704bbd0fb2033c72) - Show the plan body and approach choices in the plan review card when exiting plan mode in the web UI.

- [#1103](https://github.com/MoonshotAI/kimi-code/pull/1103) [`18f7c34`](https://github.com/MoonshotAI/kimi-code/commit/18f7c34a0739dab454af1f09d951a1bbf278cccb) - Show a line-by-line diff when the agent edits or writes a file in the web chat.

### Patch Changes

- [#1072](https://github.com/MoonshotAI/kimi-code/pull/1072) [`a86bb97`](https://github.com/MoonshotAI/kimi-code/commit/a86bb9757d99f32983e82a6a82fd3ccaab691b1a) - Improve the image paste hint.

- [#1076](https://github.com/MoonshotAI/kimi-code/pull/1076) [`500677a`](https://github.com/MoonshotAI/kimi-code/commit/500677ab8baf9081b73a35df5fbbcfc49cb2f9b7) - Fix Ctrl-C during compaction so it clears a pending editor draft first instead of cancelling immediately.

- [#1067](https://github.com/MoonshotAI/kimi-code/pull/1067) [`0e227ba`](https://github.com/MoonshotAI/kimi-code/commit/0e227ba18aec793aa4c233be7c578068ae91e604) - Fix explore subagents silently losing git context when git commands time out or the directory is not a repository.

- [#1075](https://github.com/MoonshotAI/kimi-code/pull/1075) [`3aaf1e5`](https://github.com/MoonshotAI/kimi-code/commit/3aaf1e58037c4045aaa3b9fbabaffa158c60d2ca) - Fix a startup crash on Linux caused by an unhandled native clipboard error.

- [#1094](https://github.com/MoonshotAI/kimi-code/pull/1094) [`8ee5c0f`](https://github.com/MoonshotAI/kimi-code/commit/8ee5c0ff813d361733226a1606e7c724e5e38f2e) - Fix the terminal window repeatedly losing focus on Linux Wayland, which broke IME input.

- [#1057](https://github.com/MoonshotAI/kimi-code/pull/1057) [`ee69e16`](https://github.com/MoonshotAI/kimi-code/commit/ee69e16dc8fb18153d7ddff04bef1f4fc593688a) - Fix MCP server working directories when sessions are hosted by the web server.

- [#1064](https://github.com/MoonshotAI/kimi-code/pull/1064) [`a752a53`](https://github.com/MoonshotAI/kimi-code/commit/a752a5309b3c456f7da0e6141bcd435b497d127a) - Fix truncated skill descriptions missing an ellipsis in the model's skill listing.

- [#903](https://github.com/MoonshotAI/kimi-code/pull/903) [`bbd8a1a`](https://github.com/MoonshotAI/kimi-code/commit/bbd8a1a947ba26c0e59f98819cab9e20898ff0b7) - Fix `kimi web` and `/web` failing to start the background server daemon on Windows with `spawn EFTYPE` when the CLI is installed via npm/pnpm or run from source. The official single-binary install script was not affected.

- [#1070](https://github.com/MoonshotAI/kimi-code/pull/1070) [`ff17715`](https://github.com/MoonshotAI/kimi-code/commit/ff177155ca630248bcd692421faab21e7b5be069) - Stop auto-dismissing questions in the web UI after 60 seconds so they wait for the user's answer.

- [#1097](https://github.com/MoonshotAI/kimi-code/pull/1097) [`27ef516`](https://github.com/MoonshotAI/kimi-code/commit/27ef5166955b5deaecc367a4b3393909b0ccc9f9) - Add a hint to the per-turn step limit error pointing users to the loop_control.max_steps_per_turn config option.

- [#1062](https://github.com/MoonshotAI/kimi-code/pull/1062) [`ea6a4bf`](https://github.com/MoonshotAI/kimi-code/commit/ea6a4bfe6ef8914f67f254f24b0c5c543c48a341) - Preserve full tool output logs when previews are truncated and link background task completion notifications to saved output.

- [#1086](https://github.com/MoonshotAI/kimi-code/pull/1086) [`fe667d7`](https://github.com/MoonshotAI/kimi-code/commit/fe667d7c2ef113aef8a9546148f980d9adf560a3) - `/reload` now refreshes the assistant's view of plugin skills, so plugin changes take effect in the current session instead of requiring a new one.

- [#1081](https://github.com/MoonshotAI/kimi-code/pull/1081) [`8fc6aa5`](https://github.com/MoonshotAI/kimi-code/commit/8fc6aa5f6842aa78acf8f23912342b721efcf7a9) - Sync session title changes across all connected clients in server mode.

- [#1078](https://github.com/MoonshotAI/kimi-code/pull/1078) [`75ca3b2`](https://github.com/MoonshotAI/kimi-code/commit/75ca3b21609d7197bb2c9b4389901595840ac7e3) - Add Ctrl+U and Ctrl+D as page up and page down shortcuts in the task output viewer.

- [#1069](https://github.com/MoonshotAI/kimi-code/pull/1069) [`d18aa16`](https://github.com/MoonshotAI/kimi-code/commit/d18aa1666a09b038d5a107e9a37fff1031b2e847) - Reduce streaming redraw cost for long assistant messages with code blocks.

- [#1112](https://github.com/MoonshotAI/kimi-code/pull/1112) [`6a97d0b`](https://github.com/MoonshotAI/kimi-code/commit/6a97d0bf431bc7038ce801da21164a67e07422d8) - Add a copy button to user messages in the web chat.

- [#1035](https://github.com/MoonshotAI/kimi-code/pull/1035) [`ea03f30`](https://github.com/MoonshotAI/kimi-code/commit/ea03f30e5174825049ed4dfedebf8e43fbe751a4) - Render LaTeX display math (`$$…$$`) in the web chat via KaTeX. Single `$` is intentionally left as literal text, so prices, env vars, and shell paths (e.g. `$PATH`, `$5/$10`, `$HOME/bin`) are never swallowed as a formula.

- [#1084](https://github.com/MoonshotAI/kimi-code/pull/1084) [`d6e5246`](https://github.com/MoonshotAI/kimi-code/commit/d6e524682d9fb95460fceb86e17632ed858f7fcb) - Page the web session list per workspace so the first screen no longer fetches every session up front.

- [#1113](https://github.com/MoonshotAI/kimi-code/pull/1113) [`6194d3f`](https://github.com/MoonshotAI/kimi-code/commit/6194d3fad3b53e6c2b80c422fe98043145494655) - Keep the web session sidebar from re-rendering on every streaming token. The
  event reducer now reuses the `sessions` array reference for events that do not
  change sessions, so the sidebar computeds (`sessionsForView` / `workspaceGroups`
  / `mergedWorkspaces`) are no longer dirtied by unrelated high-frequency events.

- [#1087](https://github.com/MoonshotAI/kimi-code/pull/1087) [`884b65a`](https://github.com/MoonshotAI/kimi-code/commit/884b65a04014be8d68ffd406f89fc2d26af6e62c) - Fix duplicate session snapshot reloads in the bundled web UI during resync.

- [#1109](https://github.com/MoonshotAI/kimi-code/pull/1109) [`d554f9a`](https://github.com/MoonshotAI/kimi-code/commit/d554f9ac8771be09b5c9a56943167dd45108dc4f) - Show the full accumulated progress of a subagent in its detail panel, with concise tool-call summaries instead of raw JSON.

- [#1065](https://github.com/MoonshotAI/kimi-code/pull/1065) [`4b837d6`](https://github.com/MoonshotAI/kimi-code/commit/4b837d6bfbf3850807b5f88ccdd10f31e69b019c) - Create missing parent directories automatically when writing a file.

## 0.19.2

### Patch Changes

- [#999](https://github.com/MoonshotAI/kimi-code/pull/999) [`6b68aa8`](https://github.com/MoonshotAI/kimi-code/commit/6b68aa85e2a58cfdaacba5580f66a6a74550ccf6) - Add `-c` as a shorthand for `--continue`.

- [#1028](https://github.com/MoonshotAI/kimi-code/pull/1028) [`be77d5d`](https://github.com/MoonshotAI/kimi-code/commit/be77d5da03b96ebc24169ef563be1dc1c545590f) - Show a transient footer hint when an image is detected in the clipboard, displaying the platform-appropriate paste shortcut.

- [#1004](https://github.com/MoonshotAI/kimi-code/pull/1004) [`d70c3a8`](https://github.com/MoonshotAI/kimi-code/commit/d70c3a8c0121f55e5f29f9a2ad01b17df449467a) - Show the command in running Bash tool cards and allow expanding it with Ctrl+O before the result arrives.

- [#1009](https://github.com/MoonshotAI/kimi-code/pull/1009) [`e47de61`](https://github.com/MoonshotAI/kimi-code/commit/e47de610e4de9b11ccd182c0c16387f9d3fb0de4) - Add a Ctrl+T shortcut to expand and collapse a truncated todo list.

- [#1028](https://github.com/MoonshotAI/kimi-code/pull/1028) [`be77d5d`](https://github.com/MoonshotAI/kimi-code/commit/be77d5da03b96ebc24169ef563be1dc1c545590f) - Fix stale rows occasionally leaving duplicate input boxes after tall content shrinks.

- [#1028](https://github.com/MoonshotAI/kimi-code/pull/1028) [`be77d5d`](https://github.com/MoonshotAI/kimi-code/commit/be77d5da03b96ebc24169ef563be1dc1c545590f) - Fix inline images being rendered as broken escape sequences in the transcript.

- [#1027](https://github.com/MoonshotAI/kimi-code/pull/1027) [`c240bfa`](https://github.com/MoonshotAI/kimi-code/commit/c240bfab7d2b00d41b993f681be612f2db45baa7) - Fix resume not realigning a tool call that was interrupted mid-history. The synthetic interrupted result is now closed in place at the next step boundary, so later turns and deferred messages keep their recorded order instead of only the trailing exchange being repaired. The `/messages` wire transcript reducer mirrors the same closure so its folded length stays aligned with live history, preventing the later turn from being duplicated/reordered. Replay also drops a tool result whose call is no longer awaiting one, so a stale interrupted result left at the log tail by an older resume of a damaged session is not re-applied as a duplicate.

- [#1012](https://github.com/MoonshotAI/kimi-code/pull/1012) [`fd16ffb`](https://github.com/MoonshotAI/kimi-code/commit/fd16ffb80a90fda8a611a27a158b9b7a33e13303) - Show subcommand suggestions after Tab-completing a slash command name.

- [#1012](https://github.com/MoonshotAI/kimi-code/pull/1012) [`fd16ffb`](https://github.com/MoonshotAI/kimi-code/commit/fd16ffb80a90fda8a611a27a158b9b7a33e13303) - Fix the Tab key unexpectedly opening the file completion list.

- [#1044](https://github.com/MoonshotAI/kimi-code/pull/1044) [`9d197e0`](https://github.com/MoonshotAI/kimi-code/commit/9d197e0f67c879306b9d7659d66e9295e63faa5a) - Fix clipboard copy actions in the web UI when served over plain HTTP.

- [#1032](https://github.com/MoonshotAI/kimi-code/pull/1032) [`a753b05`](https://github.com/MoonshotAI/kimi-code/commit/a753b0535e44f624289715bd560cf1346149e786) - Fix code blocks nested inside list items rendering blank in the web chat after a turn finishes generating.

- [#1015](https://github.com/MoonshotAI/kimi-code/pull/1015) [`83384ee`](https://github.com/MoonshotAI/kimi-code/commit/83384ee6d46b37c00b7b8f160a7c48aebbd6921e) - Fix the composer's ↑/↓ input-history recall doing nothing right after the first message of a new session. The history is now persisted to localStorage and re-read on mount, so the docked composer no longer starts empty when it takes over from the empty-session composer. Slash commands are now recorded too — both typed-and-submitted and ones picked from the slash menu — so they can be recalled like plain messages.

- [#1003](https://github.com/MoonshotAI/kimi-code/pull/1003) [`e15edfd`](https://github.com/MoonshotAI/kimi-code/commit/e15edfd017506fde396b8b0dcf68008b61b39752) - Fix the web question prompt missing the free-text Other option.

- [#1056](https://github.com/MoonshotAI/kimi-code/pull/1056) [`b93e936`](https://github.com/MoonshotAI/kimi-code/commit/b93e9365b68d53f8f1a148e7349a5865b1b669a8) - Fix yolo mode in the web app auto-approving plan reviews and sensitive file access.

- [#971](https://github.com/MoonshotAI/kimi-code/pull/971) [`b84704b`](https://github.com/MoonshotAI/kimi-code/commit/b84704bff39ae5cb382d2a8dc0911db286e84ead) - Read large text files in bounded memory and read tail lines without scanning whole files.

- [#1020](https://github.com/MoonshotAI/kimi-code/pull/1020) [`9c553e4`](https://github.com/MoonshotAI/kimi-code/commit/9c553e4bf7d0a2c09030212fe06577343ea76a60) - Add an Alt+S shortcut in the model picker to switch the model for the current session only, without saving it as the default.

- [#1043](https://github.com/MoonshotAI/kimi-code/pull/1043) [`27df39c`](https://github.com/MoonshotAI/kimi-code/commit/27df39c7ed2b012815c380a33fe56bd37c7fc7c1) - Fix web chat stop actions so stale prompt ids fall back to cancelling the active session.

- [#1036](https://github.com/MoonshotAI/kimi-code/pull/1036) [`866b91c`](https://github.com/MoonshotAI/kimi-code/commit/866b91c8f5dc98dfc18e5c658beaa11afea5032e) - Reorganize the web app's components into area subdirectories (chat/settings/dialogs/mobile) and refresh the component path comments.

- [#1042](https://github.com/MoonshotAI/kimi-code/pull/1042) [`dc6b9ef`](https://github.com/MoonshotAI/kimi-code/commit/dc6b9ef02bf7583d166c8c5b001a960329c225f8) - Add a development-mode indicator to the web sidebar for local development.

- [#1047](https://github.com/MoonshotAI/kimi-code/pull/1047) [`98d3e5b`](https://github.com/MoonshotAI/kimi-code/commit/98d3e5b71d5760475f7a5a23b2b794584d12b89b) - Keep the web sidebar's workspace order stable and let workspaces be reordered by drag-and-drop, persisted locally instead of following recent activity; sessions now also float to the top of their group as soon as a new message arrives.

- [#1034](https://github.com/MoonshotAI/kimi-code/pull/1034) [`603a767`](https://github.com/MoonshotAI/kimi-code/commit/603a7679de91e221802a7f7b0ab7df23c7e5526c) - Extract the composer's image/video attachment handling into a reusable composable.

- [#1031](https://github.com/MoonshotAI/kimi-code/pull/1031) [`2bfd686`](https://github.com/MoonshotAI/kimi-code/commit/2bfd6860e487f902be53fd5f52f03e66d1839ae2) - Extract the composer's text state and per-session draft persistence into a reusable composable.

- [#1011](https://github.com/MoonshotAI/kimi-code/pull/1011) [`fb780fc`](https://github.com/MoonshotAI/kimi-code/commit/fb780fce9665e2119cee6d0bc7f85895c6970865) - Extract the composer's shell-style input-history recall into a reusable composable.

- [#1030](https://github.com/MoonshotAI/kimi-code/pull/1030) [`661c1fb`](https://github.com/MoonshotAI/kimi-code/commit/661c1fbe5b026ec32d80696290a18313b24eafef) - Extract the composer's @-mention menu logic into a reusable composable.

- [#1026](https://github.com/MoonshotAI/kimi-code/pull/1026) [`318c964`](https://github.com/MoonshotAI/kimi-code/commit/318c964f074123ad228cbddcf7809fa4baaa7fb2) - Extract the composer's slash-command menu logic into a reusable composable.

- [#1045](https://github.com/MoonshotAI/kimi-code/pull/1045) [`ac1882f`](https://github.com/MoonshotAI/kimi-code/commit/ac1882fe28c906904ffaacd8434bb20e689d6677) - Persist the collapsed state of workspace groups in the web sidebar across page reloads.

- [#1001](https://github.com/MoonshotAI/kimi-code/pull/1001) [`ea1b33b`](https://github.com/MoonshotAI/kimi-code/commit/ea1b33b6743b822aa5083dbeb2d5e84a78b0ab3d) - Extract pure turn-rendering helpers out of the chat pane into their own module.

- [#1010](https://github.com/MoonshotAI/kimi-code/pull/1010) [`a2650f8`](https://github.com/MoonshotAI/kimi-code/commit/a2650f85d467707e7c85d22cff590f68852d33f3) - Extract the beta conversation outline (table of contents) into its own component.

- [#998](https://github.com/MoonshotAI/kimi-code/pull/998) [`3e4793d`](https://github.com/MoonshotAI/kimi-code/commit/3e4793d6111059cbfb97159f682ed4bd7a33441d) - Extract the workspace group rendering out of the sidebar into its own component.

- [#985](https://github.com/MoonshotAI/kimi-code/pull/985) [`92c2cf0`](https://github.com/MoonshotAI/kimi-code/commit/92c2cf0ef57f00928d337bcfeb1d7eff9b0d0f7f) - Allow the web sidebar and detail panel to be resized up to the available viewport width, keeping their resize handles reachable on narrow windows.

- [#1033](https://github.com/MoonshotAI/kimi-code/pull/1033) [`b1e6b64`](https://github.com/MoonshotAI/kimi-code/commit/b1e6b6431903fde002fdddbdfcabfab39f3ef5c5) - Optimize the loading tips display.

## 0.19.1

### Patch Changes

- [#992](https://github.com/MoonshotAI/kimi-code/pull/992) [`7341fb4`](https://github.com/MoonshotAI/kimi-code/commit/7341fb4979523d4429ccf9177b5e3907f544d8c0) - Fix ACP editors such as Zed failing to start a new thread.

- [#984](https://github.com/MoonshotAI/kimi-code/pull/984) [`da81858`](https://github.com/MoonshotAI/kimi-code/commit/da81858802127cb8bb8ed2deaa1989793b356adf) - Clear all per-session state when a session is archived or removed, so archived sessions no longer leave orphaned data behind.

- [#978](https://github.com/MoonshotAI/kimi-code/pull/978) [`d4ae02d`](https://github.com/MoonshotAI/kimi-code/commit/d4ae02d82e9da0d163ea4235a54d6535c591172e) - Fix the web sidebar's unread dots getting out of sync across browser tabs.

- [#979](https://github.com/MoonshotAI/kimi-code/pull/979) [`8c6cade`](https://github.com/MoonshotAI/kimi-code/commit/8c6cade69efa42fdcc280f51a283ea6f717d62fc) - Consolidate web client localStorage access and split the root state store and app shell into focused composables.

## 0.19.0

### Minor Changes

- [#812](https://github.com/MoonshotAI/kimi-code/pull/812) [`c0eeca2`](https://github.com/MoonshotAI/kimi-code/commit/c0eeca24692edd736eecd3c2541d7566bac9f80f) - Added the ability to add extra workspace directories:

  - Use the `/add-dir <path>` command to add extra working directories to the current session, or remember them for the project.
  - Use `kimi --add-dir <path>` to add them on startup.
  - Project-level local config is now managed in `.kimi-code/local.toml`; we recommend adding it to your `.gitignore`.

- [#975](https://github.com/MoonshotAI/kimi-code/pull/975) [`c5c1834`](https://github.com/MoonshotAI/kimi-code/commit/c5c18347251221fab74e4f452ac4910116c4224d) - Speed up session snapshot loading with a direct disk reader and a request timeout safeguard, keeping the previous path as a legacy fallback.

### Patch Changes

- [#910](https://github.com/MoonshotAI/kimi-code/pull/910) [`7644f10`](https://github.com/MoonshotAI/kimi-code/commit/7644f1036ca1079e4527c0b1c825ec5384d6d8da) - Fix provider requests failing when restored conversation history contains empty text content blocks.

- [#963](https://github.com/MoonshotAI/kimi-code/pull/963) [`4292ae9`](https://github.com/MoonshotAI/kimi-code/commit/4292ae9f9bc49e9edaaaeae50dbddabbd4b9bb25) - Surface provider safety-policy blocks instead of silently treating them as completed turns, and prevent the context token count from dropping to zero after a filtered response.

- [#970](https://github.com/MoonshotAI/kimi-code/pull/970) [`2730079`](https://github.com/MoonshotAI/kimi-code/commit/27300797f2149900219b05dda49dce65e71fa85a) - Detect the real image format from file contents when reading media, so a mismatched filename extension no longer produces a data URL the model API rejects.

- [#977](https://github.com/MoonshotAI/kimi-code/pull/977) [`d521932`](https://github.com/MoonshotAI/kimi-code/commit/d521932c3e99a0c5fa1d5d658cf1cd64f0306a75) - Stop showing unread dots on cancelled or failed sessions in the web sidebar.

- [#957](https://github.com/MoonshotAI/kimi-code/pull/957) [`b57fc90`](https://github.com/MoonshotAI/kimi-code/commit/b57fc905fe480aac07839dd0213768dbeb2a8002) - Fix commands flashing an empty console window on Windows.

- [#821](https://github.com/MoonshotAI/kimi-code/pull/821) [`ba64072`](https://github.com/MoonshotAI/kimi-code/commit/ba64072559c1e9bb3447ede39991ac2e8bdb7645) - Allow long-running foreground commands and subagents to be moved into background tasks with Ctrl+B, and inspect them via the `/tasks` panel.

- [#812](https://github.com/MoonshotAI/kimi-code/pull/812) [`c0eeca2`](https://github.com/MoonshotAI/kimi-code/commit/c0eeca24692edd736eecd3c2541d7566bac9f80f) - Polish file mention UX.

- [#974](https://github.com/MoonshotAI/kimi-code/pull/974) [`d434d8f`](https://github.com/MoonshotAI/kimi-code/commit/d434d8f0d809599f4ae7de77b58e337bfd4ebcc9) - Unify image format detection when sniffing fails.

- [#958](https://github.com/MoonshotAI/kimi-code/pull/958) [`98905eb`](https://github.com/MoonshotAI/kimi-code/commit/98905eb409ec643fd916a13beecec85212f834bd) - Show longer branch names in the web chat header and expose the full name on hover.

- [#964](https://github.com/MoonshotAI/kimi-code/pull/964) [`4223739`](https://github.com/MoonshotAI/kimi-code/commit/42237392ddc3a0816c045da23e77c4875cc692e5) - Keep the web page title fixed instead of changing with the session or workspace name.

- [#973](https://github.com/MoonshotAI/kimi-code/pull/973) [`3b9938b`](https://github.com/MoonshotAI/kimi-code/commit/3b9938b4c3a386394ed4d35c7b89b48878476977) - Consolidate web client localStorage access and decouple appearance/notification state into dedicated modules.

## 0.18.0

### Minor Changes

- [#888](https://github.com/MoonshotAI/kimi-code/pull/888) [`58898de`](https://github.com/MoonshotAI/kimi-code/commit/58898de0200d6626ca634e344fe85b860abcfd1b) - Add an environment variable to cap AgentSwarm concurrency during the initial ramp, so large swarms do not trip provider rate limits as easily.

- [#895](https://github.com/MoonshotAI/kimi-code/pull/895) [`495fe8c`](https://github.com/MoonshotAI/kimi-code/commit/495fe8c674d654cdf87217ca4ada775507f861f6) - Add instant session search to the web sidebar, filtering by title and the last user prompt.

### Patch Changes

- [#896](https://github.com/MoonshotAI/kimi-code/pull/896) [`de610de`](https://github.com/MoonshotAI/kimi-code/commit/de610deb5f760606b82cc595e59c5176cc66ce82) - Fix the web workspace session count so it drops to 0 after archiving the last session instead of staying at 1.

- [#876](https://github.com/MoonshotAI/kimi-code/pull/876) [`49183d8`](https://github.com/MoonshotAI/kimi-code/commit/49183d8729e3e7d361a253dc5c68f409e6382ba9) - Suggest `/reload` alongside `/new` in plugin-change hints.

- [#867](https://github.com/MoonshotAI/kimi-code/pull/867) [`d1dc2a3`](https://github.com/MoonshotAI/kimi-code/commit/d1dc2a3e77ec1422d60cb008c5520a44a2ed7c00) - Redesign the web OAuth login dialog: lead with a single "Authorize in browser" button that opens the verification link with the device code already embedded, demote manual code entry to a clearly secondary fallback, and drop the duplicate open-browser and cancel controls so the order of steps is unambiguous.

- [#867](https://github.com/MoonshotAI/kimi-code/pull/867) [`d1dc2a3`](https://github.com/MoonshotAI/kimi-code/commit/d1dc2a3e77ec1422d60cb008c5520a44a2ed7c00) - Fix the web login slash command description to match the browser authorization flow.

- [#893](https://github.com/MoonshotAI/kimi-code/pull/893) [`d7ec056`](https://github.com/MoonshotAI/kimi-code/commit/d7ec05686a09580f9ffd99f6ef26385aed8eb02c) - Add scroll-up lazy loading for older messages in the web chat session view, and fix the "new messages" pill overlapping the composer dock.

- [#882](https://github.com/MoonshotAI/kimi-code/pull/882) [`8ab9e96`](https://github.com/MoonshotAI/kimi-code/commit/8ab9e969637ffee18b09a0b265ffa860c5a2e11c) - Fix the web app only loading the 20 most recent sessions; it now follows pagination so older sessions are reachable.

- [#889](https://github.com/MoonshotAI/kimi-code/pull/889) [`23277a5`](https://github.com/MoonshotAI/kimi-code/commit/23277a574c7e0782c04f62e10370494247be3a66) - Show the connected server version in the web settings General tab.

- [#881](https://github.com/MoonshotAI/kimi-code/pull/881) [`7bc3d99`](https://github.com/MoonshotAI/kimi-code/commit/7bc3d99933b0bbc3f9188a2b02bcc90e81623f72) - Keep the highlighted web slash command visible while navigating a long slash menu.

- [#878](https://github.com/MoonshotAI/kimi-code/pull/878) [`a74a6b7`](https://github.com/MoonshotAI/kimi-code/commit/a74a6b7f6b1d13d24eae356a2208c012128b180d) - Allow long web slash command names and descriptions to wrap without overflowing the slash menu.

- [#878](https://github.com/MoonshotAI/kimi-code/pull/878) [`a74a6b7`](https://github.com/MoonshotAI/kimi-code/commit/a74a6b7f6b1d13d24eae356a2208c012128b180d) - Fix web slash skill selection sending immediately and allow slash search to match skill names by substring.

## 0.17.1

### Patch Changes

- [#861](https://github.com/MoonshotAI/kimi-code/pull/861) [`bd09795`](https://github.com/MoonshotAI/kimi-code/commit/bd0979578bcad5fe3bf989e022b7823824f3f25c) - Prevent the web login dialog from closing when clicking the backdrop.

- [#860](https://github.com/MoonshotAI/kimi-code/pull/860) [`0e2877b`](https://github.com/MoonshotAI/kimi-code/commit/0e2877bee347466ed6cc8afda9f9faf338069012) - Stop the background local server from locking the directory it was started in.

- [#860](https://github.com/MoonshotAI/kimi-code/pull/860) [`0e2877b`](https://github.com/MoonshotAI/kimi-code/commit/0e2877bee347466ed6cc8afda9f9faf338069012) - Fix the local server failing to start in the background on the native binary.

- [#861](https://github.com/MoonshotAI/kimi-code/pull/861) [`bd09795`](https://github.com/MoonshotAI/kimi-code/commit/bd0979578bcad5fe3bf989e022b7823824f3f25c) - Group the default model dropdown in web settings by provider.

## 0.17.0

### Minor Changes

- [#625](https://github.com/MoonshotAI/kimi-code/pull/625) [`9a8fea5`](https://github.com/MoonshotAI/kimi-code/commit/9a8fea5c85177cd887896108c05ba9e174f28250) - Add the server-hosted web UI and the CLI commands that power it:

  - `kimi server` to start, stop, and manage the local server.
  - `kimi web` to open the server-hosted web UI in a browser.
  - Server REST and WebSocket APIs for the web client.
  - Web chat layout, session list, auto-scroll, and related behaviors.

### Patch Changes

- [#838](https://github.com/MoonshotAI/kimi-code/pull/838) [`843a731`](https://github.com/MoonshotAI/kimi-code/commit/843a731097fc18b2e41ab0405b5fbcb6149ba55c) - Show the underlying connection error when OAuth token refresh fails after internal retries, instead of prompting for login. Token refresh failures are no longer re-retried at the agent loop level.

- [#849](https://github.com/MoonshotAI/kimi-code/pull/849) [`254f946`](https://github.com/MoonshotAI/kimi-code/commit/254f946a506b01df7a559ed63bd8d705e9fa7496) - Skip debug TPS when the output stream is too short to measure reliably.

- [#833](https://github.com/MoonshotAI/kimi-code/pull/833) [`a71b2e3`](https://github.com/MoonshotAI/kimi-code/commit/a71b2e3123ff8454f725b3d24e8c985608c5c4f9) - Restore the turn counter from persisted loop events on resume so post-resume turns no longer reuse turn ids that already appear in history.

- [#853](https://github.com/MoonshotAI/kimi-code/pull/853) [`05fe759`](https://github.com/MoonshotAI/kimi-code/commit/05fe7595ab9bac8230fd9f2fe7bdbaaa157ddc9b) - Fix the web login page and no-workspace conversation startup flow.

## 0.16.0

### Minor Changes

- [#788](https://github.com/MoonshotAI/kimi-code/pull/788) [`efdf8a1`](https://github.com/MoonshotAI/kimi-code/commit/efdf8a1b2d4e906fbb35620083c3e7b490e0e88a) - Add a built-in `kimi vis` command that launches the session visualizer in your browser, pointed at your local sessions. Supports `--port`/`--host`, `--no-open`, and `kimi vis <sessionId>` deep-links.

### Patch Changes

- [#790](https://github.com/MoonshotAI/kimi-code/pull/790) [`d0d5821`](https://github.com/MoonshotAI/kimi-code/commit/d0d58219007cd9d7355f1ea8900e9777b66abda2) - Stop Anthropic-compatible providers from reading ambient Anthropic shell credentials and custom headers.

- [#809](https://github.com/MoonshotAI/kimi-code/pull/809) [`6f442bd`](https://github.com/MoonshotAI/kimi-code/commit/6f442bd8cde29e21526fa36c9836e2d4c282b4bf) - Add configurable banner display frequencies with local display state.

- [#807](https://github.com/MoonshotAI/kimi-code/pull/807) [`b45672c`](https://github.com/MoonshotAI/kimi-code/commit/b45672cdaac9959024c3ae36bf35b16a423aa1dc) - Close wrapped output streams when buffered readers are destroyed.

- [#813](https://github.com/MoonshotAI/kimi-code/pull/813) [`7b5b818`](https://github.com/MoonshotAI/kimi-code/commit/7b5b8188157ec902e5cd4e73545bc5ca6c52bb76) - Fix repeated compaction handling when context remains over the blocking threshold.

- [#801](https://github.com/MoonshotAI/kimi-code/pull/801) [`ff332be`](https://github.com/MoonshotAI/kimi-code/commit/ff332be6d364ce3d5974133deb7c76220684181a) - Polish queue pane styling

- [#802](https://github.com/MoonshotAI/kimi-code/pull/802) [`aa1896c`](https://github.com/MoonshotAI/kimi-code/commit/aa1896ca749e41a67d7c4b655dcc8be830cbec82) - Reduce the maximum height of the /btw side panel from half to one-third of the terminal.

- [#805](https://github.com/MoonshotAI/kimi-code/pull/805) [`3e6196e`](https://github.com/MoonshotAI/kimi-code/commit/3e6196e6b227c66860651f4335e06973865b2714) - Project session replay ranges over rendered replay records instead of raw persisted records.

- [#804](https://github.com/MoonshotAI/kimi-code/pull/804) [`299b9fc`](https://github.com/MoonshotAI/kimi-code/commit/299b9fcad4c9c4b755fae4dfae01a1dbf60aec3c) - Prevent session shutdown from resuming the agent when stopping background tasks.

- [#823](https://github.com/MoonshotAI/kimi-code/pull/823) [`90fc04b`](https://github.com/MoonshotAI/kimi-code/commit/90fc04b7072ec20055022c50583d35286ca715a6) - Remove redundant LLM request logging context plumbing.

## 0.15.0

### Minor Changes

- [#779](https://github.com/MoonshotAI/kimi-code/pull/779) [`2746c71`](https://github.com/MoonshotAI/kimi-code/commit/2746c71c47058d9a3bb73e27a07ebfcf44bf4119) - Add an all-sessions picker view with name search, paginated browsing, and clipboard-ready resume commands for sessions in other working directories.

- [#744](https://github.com/MoonshotAI/kimi-code/pull/744) [`18f299f`](https://github.com/MoonshotAI/kimi-code/commit/18f299fd0b266545a1f7cebae9f58b83b9d9776e) - Add support for legacy SSE MCP servers alongside stdio and streamable HTTP transports.

### Patch Changes

- [#777](https://github.com/MoonshotAI/kimi-code/pull/777) [`4516f62`](https://github.com/MoonshotAI/kimi-code/commit/4516f62f6a7e4dd7675a3aec16b2a26c5e310d83) - Clarify AGENTS.md prompt guidance and mark truncated instruction files.

- [#780](https://github.com/MoonshotAI/kimi-code/pull/780) [`8a92db6`](https://github.com/MoonshotAI/kimi-code/commit/8a92db6a0c110a21c6e6e86622f498e836178e5f) - Prompt the CLI to show one brief same-language status sentence before non-trivial tool calls.

- [#786](https://github.com/MoonshotAI/kimi-code/pull/786) [`e10b25f`](https://github.com/MoonshotAI/kimi-code/commit/e10b25f9be18ca64aada0d0a3cab0e02fdbd46df) - Stop writing resume version markers into persisted agent metadata.

- [#768](https://github.com/MoonshotAI/kimi-code/pull/768) [`c6a9967`](https://github.com/MoonshotAI/kimi-code/commit/c6a996756cd8f1fb317b6eee6f4e668eebc7dc14) - Recover resumed sessions when an interrupted tool call result was not recorded.

- [#775](https://github.com/MoonshotAI/kimi-code/pull/775) [`3fa1b8e`](https://github.com/MoonshotAI/kimi-code/commit/3fa1b8ea7deb558b88073b5f7b02857e52c3f60c) - Optimize the npm packaging system.

- [#343](https://github.com/MoonshotAI/kimi-code/pull/343) [`73be7ba`](https://github.com/MoonshotAI/kimi-code/commit/73be7ba17d41df7999d4c1fba410994e7024eb7b) - Repair mismatched JSON Schema types emitted by Xcode 26.5 MCP server for Moonshot compatibility.

- [#777](https://github.com/MoonshotAI/kimi-code/pull/777) [`4516f62`](https://github.com/MoonshotAI/kimi-code/commit/4516f62f6a7e4dd7675a3aec16b2a26c5e310d83) - Collapse hidden directories in the workspace prompt and explain how to inspect them.

- [#766](https://github.com/MoonshotAI/kimi-code/pull/766) [`9cef896`](https://github.com/MoonshotAI/kimi-code/commit/9cef89656311974a57e6675f474ea6c2adb1d8e9) - Clarify that compaction summaries must be emitted in the final answer.

- [#765](https://github.com/MoonshotAI/kimi-code/pull/765) [`046856b`](https://github.com/MoonshotAI/kimi-code/commit/046856b740afb604132e914f1fc489de72394036) - Read media files using header-detected types before falling back to media extensions.

- [#779](https://github.com/MoonshotAI/kimi-code/pull/779) [`2746c71`](https://github.com/MoonshotAI/kimi-code/commit/2746c71c47058d9a3bb73e27a07ebfcf44bf4119) - Show the all-sessions toggle hint when the current working directory has no sessions.

- [#785](https://github.com/MoonshotAI/kimi-code/pull/785) [`4578f05`](https://github.com/MoonshotAI/kimi-code/commit/4578f05f44101f24d45c6452e2a6993cbb52e331) - Include the skill's directory on the loaded-skill context block so the agent can locate a skill's bundled resources (scripts, templates) after it is invoked.

- [#784](https://github.com/MoonshotAI/kimi-code/pull/784) [`a562ef5`](https://github.com/MoonshotAI/kimi-code/commit/a562ef54e537a36211c48f0fe19e9252e83397a0) - Decouple agent skill access from session-specific registry implementations.

- [#772](https://github.com/MoonshotAI/kimi-code/pull/772) [`d47e699`](https://github.com/MoonshotAI/kimi-code/commit/d47e699015f02f4f76723aa8fb17d51a74aa74ff) - Do not carry obsolete legacy loop, background, plan, yolo, or unknown experimental flags into migrated config files.

- [#783](https://github.com/MoonshotAI/kimi-code/pull/783) [`e2a407c`](https://github.com/MoonshotAI/kimi-code/commit/e2a407ce31685220b2f891a7f6d8b89c62418c98) - Keep TUI components within narrow terminal widths by wrapping, compacting, or truncating lines that could exceed the render width.

- [#776](https://github.com/MoonshotAI/kimi-code/pull/776) [`ecd7a0a`](https://github.com/MoonshotAI/kimi-code/commit/ecd7a0afb646d14a14c780a4088fd8a59da134ad) - Resolve model capabilities through a static lookup instead of instantiating a temporary provider.

- [#767](https://github.com/MoonshotAI/kimi-code/pull/767) [`a355f2a`](https://github.com/MoonshotAI/kimi-code/commit/a355f2af2fd68ad9e2bdc72ce854cd18c8242ce8) - Prioritize clearing draft editor text before Ctrl-C cancels an active stream.

- [#787](https://github.com/MoonshotAI/kimi-code/pull/787) [`1eb363f`](https://github.com/MoonshotAI/kimi-code/commit/1eb363f655aa44abc1e5c3af89016f00764ecc95) - Extend the same-language rule to the model's reasoning, so thinking follows the user's language while keeping code and technical terms in their original form.

## 0.14.3

### Patch Changes

- [#713](https://github.com/MoonshotAI/kimi-code/pull/713) [`f874251`](https://github.com/MoonshotAI/kimi-code/commit/f874251288927243a9b9d4bfd546e8c17754d566) - Refresh provider model metadata before opening the model picker.

## 0.14.2

### Patch Changes

- [#683](https://github.com/MoonshotAI/kimi-code/pull/683) [`ad239cb`](https://github.com/MoonshotAI/kimi-code/commit/ad239cb1c08266a442c9ca0382fefed87bcb1fd4) - Allow `--auto`, `--yolo`, and `--plan` to be combined with `--session` or `--continue` by applying the requested mode to the resumed session.

- [#690](https://github.com/MoonshotAI/kimi-code/pull/690) [`7f0dde2`](https://github.com/MoonshotAI/kimi-code/commit/7f0dde2ece3f9a004e934d69258dfd47c954043c) - Fix endless desktop notifications in iTerm2 by only sending terminal progress sequences to terminals that support them.

- [#651](https://github.com/MoonshotAI/kimi-code/pull/651) [`c39c625`](https://github.com/MoonshotAI/kimi-code/commit/c39c62590db708fc81bd8627ea661c38f3fff9af) - Qualify sub-skill names with their parent prefix and expose sub-skills as dotted slash commands in the TUI.

- [#617](https://github.com/MoonshotAI/kimi-code/pull/617) [`911e7c3`](https://github.com/MoonshotAI/kimi-code/commit/911e7c3fcfc8a005b1b8d90388260d1a4032f76f) - Show completed and cancelled compaction records correctly when resuming a session.

- [#676](https://github.com/MoonshotAI/kimi-code/pull/676) [`dcf3075`](https://github.com/MoonshotAI/kimi-code/commit/dcf30754d09c7560101bc410387792194c3fe2b4) - Stream foreground Bash stdout and stderr while commands are still running.

- [#692](https://github.com/MoonshotAI/kimi-code/pull/692) [`7ca9bdf`](https://github.com/MoonshotAI/kimi-code/commit/7ca9bdfed516d148b063229a9686a28f9e29aaef) - Skip re-entering plan mode when resuming a session that is already in plan mode (previously failed with "Already in plan mode"), and stop re-applying `--auto`/`--yolo`/`--plan` startup flags when switching sessions through the `/sessions` picker.

- [#675](https://github.com/MoonshotAI/kimi-code/pull/675) [`d1ba145`](https://github.com/MoonshotAI/kimi-code/commit/d1ba14562bafdb6b93c3eec1b5c453186507ed56) - Sync custom registry provider additions, removals, and rotated registry keys during startup refresh.

- [#689](https://github.com/MoonshotAI/kimi-code/pull/689) [`8d251f8`](https://github.com/MoonshotAI/kimi-code/commit/8d251f8ab44ead65f6c1bb264980ee7d075142ad) - Drop invalid config.toml sections with a warning instead of failing to start.

## 0.14.1

### Patch Changes

- [#643](https://github.com/MoonshotAI/kimi-code/pull/643) [`4e5043b`](https://github.com/MoonshotAI/kimi-code/commit/4e5043b03b2fb03374550dc65d04871bc83e932a) - Require AgentSwarm tool calls to run alone in a model response.

- [#631](https://github.com/MoonshotAI/kimi-code/pull/631) [`2961425`](https://github.com/MoonshotAI/kimi-code/commit/296142544ec64e93c9083a51d3a53a83496d10cb) - Wrap long command and skill descriptions in the autocomplete menu onto a second line instead of cutting them off.

- [#661](https://github.com/MoonshotAI/kimi-code/pull/661) [`0927f79`](https://github.com/MoonshotAI/kimi-code/commit/0927f79883e036d0127d4384f60f8e486afb3b8c) - Cancel active turns during session shutdown so foreground shell commands do not outlive prompt-mode exits.

- [#604](https://github.com/MoonshotAI/kimi-code/pull/604) [`7ec738c`](https://github.com/MoonshotAI/kimi-code/commit/7ec738c4a1de41b3a042cfb48700dfaf51e9de94) - Fix premature stream close errors when shell processes time out or are killed.

- [#632](https://github.com/MoonshotAI/kimi-code/pull/632) [`d8cdebf`](https://github.com/MoonshotAI/kimi-code/commit/d8cdebf3c03efa3a3dfa4f1deb3186a8f8f7f5ef) - Degrade unsupported audio/video to placeholder text and reattach tool result media instead of silently dropping them.

- [#628](https://github.com/MoonshotAI/kimi-code/pull/628) [`0ee9106`](https://github.com/MoonshotAI/kimi-code/commit/0ee91066eaa8ec794c8337faefc14d1b1200ce82) - Fix ACP file reads and edits for Windows workspaces opened through IDE clients.

- [#658](https://github.com/MoonshotAI/kimi-code/pull/658) [`0381329`](https://github.com/MoonshotAI/kimi-code/commit/0381329570d3dca9fd861761c843968cc1c5e927) - Send OpenAI Responses system prompts as request instructions.

- [#654](https://github.com/MoonshotAI/kimi-code/pull/654) [`ff80327`](https://github.com/MoonshotAI/kimi-code/commit/ff803273440f3a2ff53d2c529c6fc892fde1d93f) - Propagate configured execution environment overrides across spawned processes.

- [#644](https://github.com/MoonshotAI/kimi-code/pull/644) [`a58b5b2`](https://github.com/MoonshotAI/kimi-code/commit/a58b5b20bb42228c72277daba9fa07bb1cd539a6) - Polish builtin skills.

- [#649](https://github.com/MoonshotAI/kimi-code/pull/649) [`a2c5e1b`](https://github.com/MoonshotAI/kimi-code/commit/a2c5e1be25484f7c52f729e333196c485f83b84c) - Add runtime support for dynamic MCP server updates, reference skills, replay timestamps, and Node file uploads.

- [#631](https://github.com/MoonshotAI/kimi-code/pull/631) [`2961425`](https://github.com/MoonshotAI/kimi-code/commit/296142544ec64e93c9083a51d3a53a83496d10cb) - Find slash commands by their aliases in autocomplete — typing `/clear` now suggests `new (clear)`.

- [#648](https://github.com/MoonshotAI/kimi-code/pull/648) [`54302ad`](https://github.com/MoonshotAI/kimi-code/commit/54302ad612294056a47ada74b76737f2284861b5) - Prevent overlapping interactive agent requests from using the wrong active agent.

- [#641](https://github.com/MoonshotAI/kimi-code/pull/641) [`30459af`](https://github.com/MoonshotAI/kimi-code/commit/30459af6abc8308e7f13822d9dbef3a5be80dd4a) - Stop background tasks by default when sessions close.

- [#645](https://github.com/MoonshotAI/kimi-code/pull/645) [`1b58aa8`](https://github.com/MoonshotAI/kimi-code/commit/1b58aa8cdf675e6f4c02cd083feb55debbe9b3f1) - Add a YOLO choice when starting swarm tasks from Manual mode.

- [#655](https://github.com/MoonshotAI/kimi-code/pull/655) [`1e2e679`](https://github.com/MoonshotAI/kimi-code/commit/1e2e679693af2fc97826078aa671555a3a900349) - Display a tips banner below the welcome panel on startup.

## 0.14.0

### Minor Changes

- [#607](https://github.com/MoonshotAI/kimi-code/pull/607) [`b253a82`](https://github.com/MoonshotAI/kimi-code/commit/b253a82a7a5f7d91883dc77a30b8b38f8b6e1470) - Add an `Interrupt` hook event that fires when the user interrupts a turn (e.g. pressing Esc), letting hooks observe the turn stopping instead of getting stuck on a working state.

### Patch Changes

- [#626](https://github.com/MoonshotAI/kimi-code/pull/626) [`856ec00`](https://github.com/MoonshotAI/kimi-code/commit/856ec002906f4964086915ceb9aa616b89ab6594) - Preserve image outputs from tools when using OpenAI-compatible chat completions.

## 0.13.1

### Patch Changes

- [#610](https://github.com/MoonshotAI/kimi-code/pull/610) [`b747c6a`](https://github.com/MoonshotAI/kimi-code/commit/b747c6a9501e208250d09cf9a2810c885c6ce91b) - Add Claude Fable 5 support to the Anthropic provider.

- [#615](https://github.com/MoonshotAI/kimi-code/pull/615) [`494554e`](https://github.com/MoonshotAI/kimi-code/commit/494554eac5d34d6a3c5c36b6fb2b2e5397b07f0c) - Add an interactive undo selector and clearer undo-limit messages.

- [#598](https://github.com/MoonshotAI/kimi-code/pull/598) [`32d7080`](https://github.com/MoonshotAI/kimi-code/commit/32d708083730c14090f855b1fcb650e2bc713797) - Clarify active skill prompts so loaded skills are no longer represented as system reminders.

- [#595](https://github.com/MoonshotAI/kimi-code/pull/595) [`1580f35`](https://github.com/MoonshotAI/kimi-code/commit/1580f35136eed02331dcff6c8482247d5cf35458) - Fix Kimi Datasource to use the matching OAuth credentials and service endpoint for the active Kimi Code environment.

- [#619](https://github.com/MoonshotAI/kimi-code/pull/619) [`1fbe0e4`](https://github.com/MoonshotAI/kimi-code/commit/1fbe0e4ee89241bee6b5b1d5a4a38b6c6de3c5bf) - Fix goal marker text overflowing terminal width.

- [#612](https://github.com/MoonshotAI/kimi-code/pull/612) [`4603d8a`](https://github.com/MoonshotAI/kimi-code/commit/4603d8ad6e92a303f396f3d79d4e4d212d1c4b14) - Prevent forking sessions during active turns and consolidate wire protocol definitions into a shared internal package.

- [#540](https://github.com/MoonshotAI/kimi-code/pull/540) [`2ebe387`](https://github.com/MoonshotAI/kimi-code/commit/2ebe38769fc50215a7c94a362cd4e943130e1143) - Tighten file tool guidance to route incremental edits through Edit.

- [#606](https://github.com/MoonshotAI/kimi-code/pull/606) [`a1b419a`](https://github.com/MoonshotAI/kimi-code/commit/a1b419ab5901d16ab9527eef62bcd468e76b27a3) - YOLO mode no longer asks before writing or editing files outside the working directory.

## 0.13.0

### Minor Changes

- [#484](https://github.com/MoonshotAI/kimi-code/pull/484) [`f863127`](https://github.com/MoonshotAI/kimi-code/commit/f863127ab7e8b8e2e9af11c54694c08900e3103a) - Add custom color themes. Define your own palette as a JSON file in `~/.kimi-code/themes/`, or generate one with the built-in `/custom-theme` skill command.

- [#582](https://github.com/MoonshotAI/kimi-code/pull/582) [`d85dc0b`](https://github.com/MoonshotAI/kimi-code/commit/d85dc0b96a3c98c6951b8f6e6fa8b663d4c95360) - Add `/import-from-cc-codex` to import selected Claude Code and Codex instructions, Skills, and MCP settings.

- [#593](https://github.com/MoonshotAI/kimi-code/pull/593) [`40506f4`](https://github.com/MoonshotAI/kimi-code/commit/40506f49d689aaf3e920c6bc9ae2b91219ee3f7f) - Show available plugin updates in the marketplace. An installed plugin whose marketplace version is newer than the local version now renders an `update <local> → <latest>` badge (and updates in place on Enter); up-to-date plugins show `installed · v<version>`. The marketplace `version` served in dev and written by the CDN build is now stamped from each plugin's manifest so "latest" stays accurate.

### Patch Changes

- [#587](https://github.com/MoonshotAI/kimi-code/pull/587) [`0abde86`](https://github.com/MoonshotAI/kimi-code/commit/0abde8662a531293fc8faa7cf9089c43ad8d6d76) - Clarify grouped subagent progress with active status breakdowns and elapsed time.

- [#594](https://github.com/MoonshotAI/kimi-code/pull/594) [`f2863af`](https://github.com/MoonshotAI/kimi-code/commit/f2863af267b2e7d5ff5b99ff80c95c379a5b0272) - Fix device login to keep the URL and code visible when the browser cannot be opened.

- [#591](https://github.com/MoonshotAI/kimi-code/pull/591) [`e48234a`](https://github.com/MoonshotAI/kimi-code/commit/e48234af576e41e630736450c66b690226707bc3) - Fix Windows builds and development launches that could fail when package binaries resolve to command shims.

- [#586](https://github.com/MoonshotAI/kimi-code/pull/586) [`7cb4a23`](https://github.com/MoonshotAI/kimi-code/commit/7cb4a23e01dfaf0e049891b90a27b36000714151) - Truncate queued message display to a single line with ellipsis when it exceeds terminal width.

## 0.12.1

### Patch Changes

- [#584](https://github.com/MoonshotAI/kimi-code/pull/584) [`11bb62c`](https://github.com/MoonshotAI/kimi-code/commit/11bb62c12f38d380a0ca1bb89ee2df67f93300e1) - Allow obsolete experimental config entries to remain without blocking startup.

- [#581](https://github.com/MoonshotAI/kimi-code/pull/581) [`aa3471f`](https://github.com/MoonshotAI/kimi-code/commit/aa3471f5d3d2960834ba3239c0b8459144bc79fa) - Pass through xhigh reasoning effort for OpenAI-compatible chat completions requests.

## 0.12.0

### Minor Changes

- [#569](https://github.com/MoonshotAI/kimi-code/pull/569) [`d7407b0`](https://github.com/MoonshotAI/kimi-code/commit/d7407b0ecfc87a3840e26ddaddb69e7f52383699) - Enable micro compaction by default while keeping its opt-out flag.

- [#531](https://github.com/MoonshotAI/kimi-code/pull/531) [`b47734c`](https://github.com/MoonshotAI/kimi-code/commit/b47734ca0bac84e0b2c4ff50cd3d5eedb9e0c7c1) - Detect Homebrew installations and use `brew upgrade kimi-code` for updates instead of falling back to npm.

- [#487](https://github.com/MoonshotAI/kimi-code/pull/487) [`4d11394`](https://github.com/MoonshotAI/kimi-code/commit/4d113949c8e906c20c7188817926f44786653923) - Honor the standard `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` environment variables, including SOCKS proxies, for all outbound traffic.

- [#569](https://github.com/MoonshotAI/kimi-code/pull/569) [`d7407b0`](https://github.com/MoonshotAI/kimi-code/commit/d7407b0ecfc87a3840e26ddaddb69e7f52383699) - Make goals, background questions, and sub-skill discovery available without experimental opt-ins.

- [#424](https://github.com/MoonshotAI/kimi-code/pull/424) [`72c4b0a`](https://github.com/MoonshotAI/kimi-code/commit/72c4b0adaa6ae0466875cd8e4066c42456195f21) - Add the `/swarm` command for running agent swarms with live progress and rate-limit-aware retries.

### Patch Changes

- [#395](https://github.com/MoonshotAI/kimi-code/pull/395) [`879a7ee`](https://github.com/MoonshotAI/kimi-code/commit/879a7eeb33a8bedf18779d74a00d78369dae3db5) - Fix ACP slash skill routing, bootstrap context reads, file and permission edge cases, subagent event handling, and stale-file edit messaging.

- [#529](https://github.com/MoonshotAI/kimi-code/pull/529) [`3b62b12`](https://github.com/MoonshotAI/kimi-code/commit/3b62b123e68cc4543bfa8fa376c7e8a24fee0afb) - Detect Git Bash installed through Scoop and other Git shims on Windows.

- [#547](https://github.com/MoonshotAI/kimi-code/pull/547) [`3765a49`](https://github.com/MoonshotAI/kimi-code/commit/3765a491636a57c0f84ba409c325df10f7613a49) - Rework file reference completion in the TUI.

- [#537](https://github.com/MoonshotAI/kimi-code/pull/537) [`8d0c91f`](https://github.com/MoonshotAI/kimi-code/commit/8d0c91faa1c878e395bffe9bafa89e10736c2384) - Wrap long single-line shell commands in approval prompts so the full command remains visible.

- [#552](https://github.com/MoonshotAI/kimi-code/pull/552) [`db82e33`](https://github.com/MoonshotAI/kimi-code/commit/db82e33a20fd1ec204672df4ba5bc38800ce8dea) - Fix goal resume behavior by restoring goal state from agent records.

- [#521](https://github.com/MoonshotAI/kimi-code/pull/521) [`9aba465`](https://github.com/MoonshotAI/kimi-code/commit/9aba465fd8689be998fa8581d04792b3c7c54359) - Fix the `/mcp` status panel border being broken by multi-line MCP server errors, which are now folded onto a single row.

- [#543](https://github.com/MoonshotAI/kimi-code/pull/543) [`0c3d556`](https://github.com/MoonshotAI/kimi-code/commit/0c3d556778f969b3c99e69e07ecba27af8bd6c29) - Fix session workdir mismatch on Windows caused by inconsistent path separators.

- [#544](https://github.com/MoonshotAI/kimi-code/pull/544) [`5cff6d6`](https://github.com/MoonshotAI/kimi-code/commit/5cff6d60273a6145ee38539b9c1306adddc66510) - Load Kimi-specific user Skills and global agent instructions from `KIMI_CODE_HOME` when it is set.

- [#536](https://github.com/MoonshotAI/kimi-code/pull/536) [`b785e26`](https://github.com/MoonshotAI/kimi-code/commit/b785e2698a2da7adc9ef10251a2aed9b243e3b5f) - Show full plan cards directly and remove the Plan card keyboard shortcut.

- [#555](https://github.com/MoonshotAI/kimi-code/pull/555) [`41ebe9f`](https://github.com/MoonshotAI/kimi-code/commit/41ebe9fb9f403e2ee6a8721640a79faa64e9210a) - Improve goal mode outcome handling with follow-up messages, safer error pauses, and clearer TUI transcript display.

- [#506](https://github.com/MoonshotAI/kimi-code/pull/506) [`f09ec7b`](https://github.com/MoonshotAI/kimi-code/commit/f09ec7bbb59af42805a93df2993301dbd317ff2d) - Remove the per-turn auto-compaction limit so long conversations can keep compacting instead of failing early.

- [#473](https://github.com/MoonshotAI/kimi-code/pull/473) [`3787c30`](https://github.com/MoonshotAI/kimi-code/commit/3787c3016a12af3434072da1cb6fd0c95821ea45) - Allow the startup session picker to exit with repeated Ctrl-C or Ctrl-D.

- [#210](https://github.com/MoonshotAI/kimi-code/pull/210) [`d995928`](https://github.com/MoonshotAI/kimi-code/commit/d995928681fa2446902a0164919cf893b81efd75) - Show the underlying error when migration fails.

- [#541](https://github.com/MoonshotAI/kimi-code/pull/541) [`2db1bd9`](https://github.com/MoonshotAI/kimi-code/commit/2db1bd9675ef3b6adf3833f05b7b6d87a137c6eb) - Fix thinking text and tool output display for subagents.

## 0.11.0

### Minor Changes

- [#468](https://github.com/MoonshotAI/kimi-code/pull/468) [`df4f2d6`](https://github.com/MoonshotAI/kimi-code/commit/df4f2d6e8611074cc0b439928f27decba53d2e9a) - Add experimental sub-skill discovery gated by the `KIMI_CODE_EXPERIMENTAL_SUB_SKILL` environment variable. Ships the `sub-skill` builtin bundle (`sub-skill.review`, `sub-skill.consolidate`) for inventorying and consolidating skills into hierarchical groups.

- [#480](https://github.com/MoonshotAI/kimi-code/pull/480) [`f555c89`](https://github.com/MoonshotAI/kimi-code/commit/f555c89de79c5d7ae59521a9ed360ad1cf045fcd) - Show built-in skills as direct slash commands and group them ahead of external skill commands.

- [#458](https://github.com/MoonshotAI/kimi-code/pull/458) [`93eb70a`](https://github.com/MoonshotAI/kimi-code/commit/93eb70a727c9724e19a31b0d2fbebb78b7390c78) - Migrate still-relevant environment variables from kimi-cli:

  - `KIMI_MODEL_TEMPERATURE`, `KIMI_MODEL_TOP_P` — sampling parameters applied globally to any `kimi` provider (not tied to `KIMI_MODEL_NAME`).
  - `KIMI_MODEL_THINKING_KEEP` — Moonshot preserved-thinking passthrough (`thinking.keep`), injected only while Thinking is on.
  - `KIMI_CODE_NO_AUTO_UPDATE` (legacy alias `KIMI_CLI_NO_AUTO_UPDATE`) — fully disables the update preflight (no check, background install, or prompt).

- [#470](https://github.com/MoonshotAI/kimi-code/pull/470) [`aa610e2`](https://github.com/MoonshotAI/kimi-code/commit/aa610e247deca737101e4de848122db1c8ee9fb3) - Use a fixed 30-minute timeout for subagents and show concise resume instructions when they time out.

### Patch Changes

- [#474](https://github.com/MoonshotAI/kimi-code/pull/474) [`658e465`](https://github.com/MoonshotAI/kimi-code/commit/658e4653fc535dad040ac3406d8ccace7a19077e) - Show the upcoming-goal confirmation with the same accent treatment as goal lifecycle messages.

- [#474](https://github.com/MoonshotAI/kimi-code/pull/474) [`658e465`](https://github.com/MoonshotAI/kimi-code/commit/658e4653fc535dad040ac3406d8ccace7a19077e) - Fix slash command autocomplete so goal text can be submitted when the cursor is before existing text.

- [#474](https://github.com/MoonshotAI/kimi-code/pull/474) [`658e465`](https://github.com/MoonshotAI/kimi-code/commit/658e4653fc535dad040ac3406d8ccace7a19077e) - Fix queued goals so failed promotion attempts do not lose or duplicate queued work.

- [#456](https://github.com/MoonshotAI/kimi-code/pull/456) [`3a98713`](https://github.com/MoonshotAI/kimi-code/commit/3a987130500fe5b403b696850165735c7d0ee076) - Show concise provider filtering errors when responses are blocked before visible output.

- [#442](https://github.com/MoonshotAI/kimi-code/pull/442) [`960a0e2`](https://github.com/MoonshotAI/kimi-code/commit/960a0e2885b5a6a32ccd62506e9dcf4e35206b6f) - Show "unknown command" instead of "too many arguments" when an invalid subcommand is entered.

- [#474](https://github.com/MoonshotAI/kimi-code/pull/474) [`658e465`](https://github.com/MoonshotAI/kimi-code/commit/658e4653fc535dad040ac3406d8ccace7a19077e) - Fix upcoming-goal queue handling while editing or pasting queued goals.

- [#457](https://github.com/MoonshotAI/kimi-code/pull/457) [`1fe5d55`](https://github.com/MoonshotAI/kimi-code/commit/1fe5d5549c84de17183c4c76a9713cd8538ca755) - Clamp OpenAI Chat Completions `xhigh` and `max` thinking effort to `high` unless the model supports `xhigh` on `v1/chat/completions`.

- [#464](https://github.com/MoonshotAI/kimi-code/pull/464) [`4f9977d`](https://github.com/MoonshotAI/kimi-code/commit/4f9977d4dcd2df14e6a310396c37af170b2eac50) - Preserve thinking effort when compacting long conversations.

- [#474](https://github.com/MoonshotAI/kimi-code/pull/474) [`658e465`](https://github.com/MoonshotAI/kimi-code/commit/658e4653fc535dad040ac3406d8ccace7a19077e) - Ask before starting goals in YOLO mode so users can switch to Auto for unattended work.

- [#461](https://github.com/MoonshotAI/kimi-code/pull/461) [`2af19e2`](https://github.com/MoonshotAI/kimi-code/commit/2af19e29b9f49163b23cade71d3bcaa6d0b11773) - Refresh provider model metadata when capabilities change without model ID changes.

- [#474](https://github.com/MoonshotAI/kimi-code/pull/474) [`658e465`](https://github.com/MoonshotAI/kimi-code/commit/658e4653fc535dad040ac3406d8ccace7a19077e) - Start upcoming goals immediately when there is no active goal to wait for.
  Support multiline edits when managing upcoming goals.

- [#474](https://github.com/MoonshotAI/kimi-code/pull/474) [`658e465`](https://github.com/MoonshotAI/kimi-code/commit/658e4653fc535dad040ac3406d8ccace7a19077e) - Highlight goal queue subcommands while typing slash commands.

## 0.10.1

### Patch Changes

- [#443](https://github.com/MoonshotAI/kimi-code/pull/443) [`15a4c64`](https://github.com/MoonshotAI/kimi-code/commit/15a4c64e5cea45c9f72d8c889f306f1f964a8ac6) - Fix a crash when starting a goal in the TUI.

## 0.10.0

### Minor Changes

- [#433](https://github.com/MoonshotAI/kimi-code/pull/433) [`85338e9`](https://github.com/MoonshotAI/kimi-code/commit/85338e9f7df5d98234fd42891e9bf2a2e6ad767b) - Add the built-in `update-config` skill — you can now have Kimi edit its own config files.

- [#420](https://github.com/MoonshotAI/kimi-code/pull/420) [`86a42a2`](https://github.com/MoonshotAI/kimi-code/commit/86a42a26a1e01f1748a937031fa76ebeaa1e28a8) - Add persistent experimental feature toggles and a TUI panel that applies confirmed changes by reloading the current session.

- [#383](https://github.com/MoonshotAI/kimi-code/pull/383) [`15d71b5`](https://github.com/MoonshotAI/kimi-code/commit/15d71b5130d949c35d9dc2641e807e08d72dce48) - Add /reload to reload the current session and apply updated config files, plus /reload-tui to reload only TUI preferences.

- [#393](https://github.com/MoonshotAI/kimi-code/pull/393) [`beb12ac`](https://github.com/MoonshotAI/kimi-code/commit/beb12ac0216818a5c5eda24fb304e4ab01792784) - Users now can prepare several goals for the agent to work on sequentially. The agent will pick up the next goal from the queue once the current goal is completed. Use `/goal next <objective>` to queue a goal and `/goal next manage` to review and change the queue interactively.

- [#431](https://github.com/MoonshotAI/kimi-code/pull/431) [`6a4e4c7`](https://github.com/MoonshotAI/kimi-code/commit/6a4e4c75d4bf6db3fefbb5c115d7a7c324bcae16) - Add a doctor command for validating Kimi Code configuration files.

### Patch Changes

- [#393](https://github.com/MoonshotAI/kimi-code/pull/393) [`beb12ac`](https://github.com/MoonshotAI/kimi-code/commit/beb12ac0216818a5c5eda24fb304e4ab01792784) - Stop carrying active and queued goals into forked sessions.

- [#408](https://github.com/MoonshotAI/kimi-code/pull/408) [`6303bd2`](https://github.com/MoonshotAI/kimi-code/commit/6303bd2936ae168c674af6e685b0eed5a890c42f) - Point session error diagnostics to the `/export-debug-zip` command.

- [#398](https://github.com/MoonshotAI/kimi-code/pull/398) [`b2801c4`](https://github.com/MoonshotAI/kimi-code/commit/b2801c4dbfe3f7e13f5468bfba1555fa12d1707c) - Set terminal tab titles without renaming the running process.

- [#403](https://github.com/MoonshotAI/kimi-code/pull/403) [`d645d7e`](https://github.com/MoonshotAI/kimi-code/commit/d645d7e443857b3c974b9fd6065027c0f0cd6953) - Start automatic background updates as soon as startup's fresh update check finds a newer version.

- [#387](https://github.com/MoonshotAI/kimi-code/pull/387) [`6e74027`](https://github.com/MoonshotAI/kimi-code/commit/6e74027fdc48ad124b2a62465bb5fd07e84d4712) - Lowercase the stale file content message in edit tool errors.

- [#428](https://github.com/MoonshotAI/kimi-code/pull/428) [`853c5fc`](https://github.com/MoonshotAI/kimi-code/commit/853c5fc43741582ecbde3b4fccf82cddffe3626e) - Ensure Nix-packaged CLI builds can find ripgrep and fd.

- [#411](https://github.com/MoonshotAI/kimi-code/pull/411) [`4598262`](https://github.com/MoonshotAI/kimi-code/commit/459826292f855592288bcfddaa1c72529a6d8c64) - Normalize malformed Responses stream rate limit errors as provider rate limit failures.

- [#405](https://github.com/MoonshotAI/kimi-code/pull/405) [`07e2e0f`](https://github.com/MoonshotAI/kimi-code/commit/07e2e0f094fcbc8a6026eb53f5a70cc437bf7c52) - Refresh the update target before showing foreground update prompts so the displayed version matches the install.

- [#399](https://github.com/MoonshotAI/kimi-code/pull/399) [`232ed87`](https://github.com/MoonshotAI/kimi-code/commit/232ed874d41de777e6ff9c539ac22d830d0b5c3a) - Keep managed OAuth credentials scoped to their configured authentication and API endpoints.

- [#407](https://github.com/MoonshotAI/kimi-code/pull/407) [`07609b4`](https://github.com/MoonshotAI/kimi-code/commit/07609b41a31499bb5c7811dbab71fa427e621efc) - Set the CLI process title to kimi-code during startup.

- [#419](https://github.com/MoonshotAI/kimi-code/pull/419) [`d0f8e24`](https://github.com/MoonshotAI/kimi-code/commit/d0f8e24e9b4d2c6dd68d93bc804a4390bf661c10) - Document the Git Bash prerequisite for Windows installs.

- [#430](https://github.com/MoonshotAI/kimi-code/pull/430) [`be0da5f`](https://github.com/MoonshotAI/kimi-code/commit/be0da5ff39641e117d60045a43a7d5d2e0b85b75) - Fail early when Git Bash is missing on Windows before starting CLI sessions.

## 0.9.0

### Minor Changes

- [#368](https://github.com/MoonshotAI/kimi-code/pull/368) [`3eafa79`](https://github.com/MoonshotAI/kimi-code/commit/3eafa79f39c06b67d18bd2c1fd5321d2d889ed90) - Add `@moonshot-ai/acp-adapter` and the `kimi acp` subcommand: kimi-code now speaks [Agent Client Protocol 0.23](https://agentclientprotocol.com/) over stdio so IDEs (Zed, JetBrains AI Chat, custom clients) can drive sessions directly — coverage matrix, Zed configuration and breaking pre-release notes are in [kimi acp Subcommand Page](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp.html).

- [#338](https://github.com/MoonshotAI/kimi-code/pull/338) [`ba7dd73`](https://github.com/MoonshotAI/kimi-code/commit/ba7dd736a3b295b2a29c229a944208c232d51458) - Add `/btw` for side-channel conversations without steering the active main turn.

- [#357](https://github.com/MoonshotAI/kimi-code/pull/357) [`179aecf`](https://github.com/MoonshotAI/kimi-code/commit/179aecf42379e8ef4091f5351c91cd460ba11bdd) - Log enabled experimental flags at startup.

- [#378](https://github.com/MoonshotAI/kimi-code/pull/378) [`e0d28b4`](https://github.com/MoonshotAI/kimi-code/commit/e0d28b4941ad6f16e69bdf56a4185655feec5320) - Allow `/btw` to open the side-channel panel before entering a question.

### Patch Changes

- [#246](https://github.com/MoonshotAI/kimi-code/pull/246) [`7d1f889`](https://github.com/MoonshotAI/kimi-code/commit/7d1f889d3dc123f44a8d14543e5aaf8aeef2c752) - Fix external editor (Ctrl+G) on Windows by removing `/bin/sh` dependency and using platform-aware shell quoting for temp file paths.

- [#365](https://github.com/MoonshotAI/kimi-code/pull/365) [`6a22523`](https://github.com/MoonshotAI/kimi-code/commit/6a2252343a0d624b326b2d369ec908bc8d60092d) - Fix goal budget tool schemas for OpenAI-compatible providers.

- [#365](https://github.com/MoonshotAI/kimi-code/pull/365) [`6a22523`](https://github.com/MoonshotAI/kimi-code/commit/6a2252343a0d624b326b2d369ec908bc8d60092d) - Use the OpenAI completion token field required by newer Chat Completions models.

- [#380](https://github.com/MoonshotAI/kimi-code/pull/380) [`8639105`](https://github.com/MoonshotAI/kimi-code/commit/86391053139ad4ea437afe79f472412fb1b106a1) - Resume saved subagents lazily when they are accessed.

- [#339](https://github.com/MoonshotAI/kimi-code/pull/339) [`a6b16ce`](https://github.com/MoonshotAI/kimi-code/commit/a6b16ce6b4bdc20ed33888975c7da7ff1919e22f) - Allow SDK runtime creation to use a separate RPC client while preserving local CLI startup.

- [#363](https://github.com/MoonshotAI/kimi-code/pull/363) [`90879f3`](https://github.com/MoonshotAI/kimi-code/commit/90879f37af2ddb941223d293a67615f8f557e3af) - Unify the interaction and visuals across TUI dialogs and selectors.

- [#365](https://github.com/MoonshotAI/kimi-code/pull/365) [`6a22523`](https://github.com/MoonshotAI/kimi-code/commit/6a2252343a0d624b326b2d369ec908bc8d60092d) - Use configured model output limits for completion token caps.

## 0.8.0

### Minor Changes

- [#319](https://github.com/MoonshotAI/kimi-code/pull/319) [`fe7db4a`](https://github.com/MoonshotAI/kimi-code/commit/fe7db4a7e361b83194eb1ebb52d27daed53be532) - Append the current todo list as markdown to compaction summaries before writing them to history.

- [#334](https://github.com/MoonshotAI/kimi-code/pull/334) [`eeefa98`](https://github.com/MoonshotAI/kimi-code/commit/eeefa98083e9d037d2ba7c59de9e5eb51b19fdd7) - Add background automatic upgrades, which can be disabled in tui.toml.

- [#270](https://github.com/MoonshotAI/kimi-code/pull/270) [`ac37d74`](https://github.com/MoonshotAI/kimi-code/commit/ac37d7448458fdb73fbe00e35856dcf44a13f734) - Add experimental goal mode for longer tasks that need more than one turn. Turn it on with `KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1` before you start Kimi.

  Use `/goal <objective>` in the TUI when you want Kimi to keep working on one task across turns. For example:

  ```text
  /goal Fix the failing checkout test
  ```

  Kimi shows the goal in the TUI and keeps progress visible while it works. Use `/goal status`, `/goal pause`, `/goal resume`, `/goal cancel`, and `/goal replace <objective>` to manage the goal. This feature is still experimental. Try it and tell us what would make it more useful.

- [#315](https://github.com/MoonshotAI/kimi-code/pull/315) [`191059d`](https://github.com/MoonshotAI/kimi-code/commit/191059d40049d3bfd07661ac03bb961eac1407f7) - Add background structured questions so agents can continue while waiting for user answers.

- [#313](https://github.com/MoonshotAI/kimi-code/pull/313) [`3c5dee8`](https://github.com/MoonshotAI/kimi-code/commit/3c5dee8836ac823fce01707f60b9c095a963060e) - Add `kimi provider` CLI subcommand with `add`, `remove`, `list`, and `catalog list` / `catalog add` actions, so providers from a custom registry (api.json) or the public models.dev catalog can be imported and managed without launching the TUI.

- [#277](https://github.com/MoonshotAI/kimi-code/pull/277) [`a217ff0`](https://github.com/MoonshotAI/kimi-code/commit/a217ff09aad0665b1501b156c2cc1f186b876087) - Add `/undo` slash command to withdraw the last prompt from conversation history, and keep replay records in sync when a prompt is undone.

- [#334](https://github.com/MoonshotAI/kimi-code/pull/334) [`eeefa98`](https://github.com/MoonshotAI/kimi-code/commit/eeefa98083e9d037d2ba7c59de9e5eb51b19fdd7) - Add a `kimi upgrade` command for manually checking and upgrade Kimi Code CLI.

- [#336](https://github.com/MoonshotAI/kimi-code/pull/336) [`7cda9c3`](https://github.com/MoonshotAI/kimi-code/commit/7cda9c3866bad6b3ce8f95c383a111e1ee5e9325) - Add approval lifecycle hook events for observing pending and completed permission prompts.

### Patch Changes

- [#285](https://github.com/MoonshotAI/kimi-code/pull/285) [`573c56e`](https://github.com/MoonshotAI/kimi-code/commit/573c56e829a10e8a45738a37250d8c15f4ab8d8d) - Consolidate background task management under the agent background runtime.

- [#314](https://github.com/MoonshotAI/kimi-code/pull/314) [`6de3d97`](https://github.com/MoonshotAI/kimi-code/commit/6de3d97d82e2c585035d1d7f969a3504f712df21) - Prevent modified keyboard release sequences from appearing after exiting the CLI.

- [#335](https://github.com/MoonshotAI/kimi-code/pull/335) [`7284f30`](https://github.com/MoonshotAI/kimi-code/commit/7284f30479142fd66b1e8a731fd00198b1e8684f) - Fix custom registry provider handling during re-import. Prevent loss of multi-provider entries and remove stale providers along with their model aliases and default model references.

- [#311](https://github.com/MoonshotAI/kimi-code/pull/311) [`80164c2`](https://github.com/MoonshotAI/kimi-code/commit/80164c2e975ba82f7c915dc3fce6cb00b9d29f6e) - Normalize glob patterns before brace expansion to prevent incorrect path matching.

- [#247](https://github.com/MoonshotAI/kimi-code/pull/247) [`58e2915`](https://github.com/MoonshotAI/kimi-code/commit/58e2915c0f726747a94a8dc5a9eda001ef0d4009) - Fix a crash in the `/sessions` picker on very narrow terminals by clamping every rendered line to the terminal width.

- [#317](https://github.com/MoonshotAI/kimi-code/pull/317) [`1f8c36a`](https://github.com/MoonshotAI/kimi-code/commit/1f8c36af288ca6120d620f3944c921bc4f0f77ce) - Fix tool output preview rendering: trim trailing empty lines, append ellipsis to multi-line Bash command headers, and truncate long single-line output by visual wrapped lines instead of raw newline count.

- [#145](https://github.com/MoonshotAI/kimi-code/pull/145) [`d912053`](https://github.com/MoonshotAI/kimi-code/commit/d912053b0d3983f4e67450c347616086cfbd1fe7) - Fix Git Bash path detection on Windows by also searching `usr\bin\bash.exe` locations, which is where bash lives in many Git for Windows installations where `bin\bash.exe` does not exist.

- [#310](https://github.com/MoonshotAI/kimi-code/pull/310) [`a4511ff`](https://github.com/MoonshotAI/kimi-code/commit/a4511ffc87a1414cb8a5295eeef1103b9ed59645) - Show the full model name in the footer status bar instead of truncating the provider prefix.

- [#283](https://github.com/MoonshotAI/kimi-code/pull/283) [`91b292e`](https://github.com/MoonshotAI/kimi-code/commit/91b292e898e9d97b0501cf787919d7f1a90c89d8) - Allow glob searches to target explicit absolute paths outside the workspace.

- [#223](https://github.com/MoonshotAI/kimi-code/pull/223) [`811f252`](https://github.com/MoonshotAI/kimi-code/commit/811f252625bc20a27687b11754b18cc68c7d50dc) - Show MCP server summary in the welcome panel and add configuration hints in the /mcp command output.

- [#229](https://github.com/MoonshotAI/kimi-code/pull/229) [`fb35bca`](https://github.com/MoonshotAI/kimi-code/commit/fb35bca032486eaefb7b9d7b612d353033e0922c) - Replace chalk named color with theme-aware hex in session-directory warning.

- [#303](https://github.com/MoonshotAI/kimi-code/pull/303) [`3d7e20e`](https://github.com/MoonshotAI/kimi-code/commit/3d7e20e6978cb35787738e12f6f352fbc2733582) - Point users to `/provider` instead of the removed `/connect` command in the welcome screen and the no-models-configured hint.

- [#135](https://github.com/MoonshotAI/kimi-code/pull/135) [`0071b63`](https://github.com/MoonshotAI/kimi-code/commit/0071b63fc83821430472e11db3c6aa613c0bdf7e) - Fix slash-activated skills not being recognized by the model due to missing system reminder wrapper.

- [#330](https://github.com/MoonshotAI/kimi-code/pull/330) [`7a47045`](https://github.com/MoonshotAI/kimi-code/commit/7a47045af2790eba0e68d5406c670ac759b21755) - Allow subagents to use custom tools registered on their parent agent.

- [#333](https://github.com/MoonshotAI/kimi-code/pull/333) [`1178c5c`](https://github.com/MoonshotAI/kimi-code/commit/1178c5cd148d9d5851574afaafb986be1dfe9b63) - Remind the model to refresh TodoList during long-running tasks and strengthen TodoList progress-tracking guidance.

- [#327](https://github.com/MoonshotAI/kimi-code/pull/327) [`8809f3e`](https://github.com/MoonshotAI/kimi-code/commit/8809f3eb114172ac64cefe43bbf9b9257c5245c0) - Fix cross-provider replay failures from incompatible tool call IDs and unsigned Claude thinking history.

## 0.7.0

### Minor Changes

- [#232](https://github.com/MoonshotAI/kimi-code/pull/232) [`a24bfb1`](https://github.com/MoonshotAI/kimi-code/commit/a24bfb1df38e58120827a1d8ed881724af2e7b23) - Add `KIMI_MODEL_ADAPTIVE_THINKING` (and a matching `adaptive_thinking` model-alias field) to force adaptive thinking (`thinking: { type: 'adaptive' }`) on or off, overriding the Anthropic model-name version inference. This lets custom-named compatible endpoints that back an adaptive-capable model opt in even when the model name does not encode a parseable Claude version.

- [#264](https://github.com/MoonshotAI/kimi-code/pull/264) [`42bb914`](https://github.com/MoonshotAI/kimi-code/commit/42bb9141d8ee7023639f943dd4c6a0f6c8fa8945) - Add `/provider` command for managing AI providers, support custom registry imports, and introduce a tabbed model selector.

- [#204](https://github.com/MoonshotAI/kimi-code/pull/204) [`ee69d0a`](https://github.com/MoonshotAI/kimi-code/commit/ee69d0ac29f56bde4957c14767d7ca436697d9cf) - Render scheduled reminders distinctly in the TUI, expose cron fired events to SDK clients, and report cron fire times with local timezone offsets.

### Patch Changes

- [#282](https://github.com/MoonshotAI/kimi-code/pull/282) [`a580cd3`](https://github.com/MoonshotAI/kimi-code/commit/a580cd3a98664e18642e0e856aeaa9b71ba93516) - Fix glob pattern backslash escaping and include match count in truncation messages.

- [#260](https://github.com/MoonshotAI/kimi-code/pull/260) [`178827d`](https://github.com/MoonshotAI/kimi-code/commit/178827db47f183df783ba63bf8f1c338f2cbd7e6) - Polish a small TUI visual interaction.

- [#267](https://github.com/MoonshotAI/kimi-code/pull/267) [`e2e1728`](https://github.com/MoonshotAI/kimi-code/commit/e2e17289fca9bcb23f05cd77f7bcb9cba5db0325) - Report truncated compaction summaries clearly and apply valid completion token budgets across supported providers.

- [#274](https://github.com/MoonshotAI/kimi-code/pull/274) [`a1dfbfe`](https://github.com/MoonshotAI/kimi-code/commit/a1dfbfeb16bcad0c2c8faa232d6d1ce4a2681d57) - Clarify Kimi Platform API key login labels and prompt details.

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
