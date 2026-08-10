# @moonshot-ai/kimi-code-sdk

## 0.14.0

### Minor Changes

- [#1735](https://github.com/MoonshotAI/kimi-code/pull/1735) [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6) Thanks [@7Sageer](https://github.com/7Sageer)! - Add global tool gating to constrain which tools agents may use, with a per-session override (v2 engine only).

### Patch Changes

- [#2030](https://github.com/MoonshotAI/kimi-code/pull/2030) [`ec88d35`](https://github.com/MoonshotAI/kimi-code/commit/ec88d352e8f4dc5e8ffd1212f016138458f69893) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix catalog-imported Claude models being wrongly locked into always-on thinking, and stop offering a misleading thinking Off option for models that cannot truly disable reasoning (such as Gemini 3). Also normalizes configured thinking effort values and unifies context-usage reporting.

- [#2015](https://github.com/MoonshotAI/kimi-code/pull/2015) [`b5efba7`](https://github.com/MoonshotAI/kimi-code/commit/b5efba7abcaf4041f81ec520097a61e6546e8c50) Thanks [@RealKai42](https://github.com/RealKai42)! - Import many more providers from the models.dev catalog: vendor SDKs like xai and openrouter now import instead of being refused (with a "guessed" note), deprecated and alpha models are filtered out, per-model gateway protocol and endpoint overrides are honored, and context limits are correct (input limit for compaction, total window for completion). Imports lacking a usable endpoint now ask for one via `--base-url` or a prompt.

- [#1976](https://github.com/MoonshotAI/kimi-code/pull/1976) [`e458323`](https://github.com/MoonshotAI/kimi-code/commit/e45832398d0d9cad98dbad1cbf1e5b103a20aace) Thanks [@liruifengv](https://github.com/liruifengv)! - Improve TUI performance and resume speed for long-running sessions.

## 0.13.4

### Patch Changes

- [#1769](https://github.com/MoonshotAI/kimi-code/pull/1769) [`d1ca65e`](https://github.com/MoonshotAI/kimi-code/commit/d1ca65e1de189617e9edbc54010e62d472a1de3d) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Support in-process editor hosts with session lifecycle, context, MCP configuration, and cross-platform session storage APIs.

## 0.13.3

### Patch Changes

- [#1488](https://github.com/MoonshotAI/kimi-code/pull/1488) [`7bd29ab`](https://github.com/MoonshotAI/kimi-code/commit/7bd29ab0117a1c15691404f411fd67f511bbb897) Thanks [@starquakee](https://github.com/starquakee)! - Rename the dynamic tool loading model capability from `select_tools` to `dynamically_loaded_tools`.

## 0.13.2

### Patch Changes

- [#1501](https://github.com/MoonshotAI/kimi-code/pull/1501) [`b91099e`](https://github.com/MoonshotAI/kimi-code/commit/b91099ed7a2590d1afa4d6e3675671da52b7661c) Thanks [@liruifengv](https://github.com/liruifengv)! - Display Extra Usage (fuel pack) balance in `/usage` and `/status` commands.

## 0.13.1

### Patch Changes

- [#1460](https://github.com/MoonshotAI/kimi-code/pull/1460) [`474ce28`](https://github.com/MoonshotAI/kimi-code/commit/474ce289dd39aa42d1a77a9a2e15531aee49aa15) Thanks [@RealKai42](https://github.com/RealKai42)! - Raise the image downscale cap from 2000px to 3000px, and fix swapped width/height for EXIF-rotated (portrait) photos in compression captions and media read notes so region readback coordinates map correctly.

## 0.13.0

### Minor Changes

- [#1369](https://github.com/MoonshotAI/kimi-code/pull/1369) [`f0896a5`](https://github.com/MoonshotAI/kimi-code/commit/f0896a53b01f7e5b9bf5b8f93d2cd7387d765f07) Thanks [@starquakee](https://github.com/starquakee)! - Add experimental progressive tool disclosure (`select_tools`). When the `tool-select` experimental flag is on and the active model declares the `select_tools` capability, MCP tool schemas stay out of the request's top-level `tools[]` (preserving the provider prompt cache); the model loads tools on demand by exact name via the new built-in `select_tools` tool, guided by `<tools_added>/<tools_removed>` announcements. Off by default and inert on models without the capability — behavior is unchanged until a supporting model is catalogued. The SDK additionally maps the `select_tools` capability when building model aliases from a catalog and reports the new flag through `getExperimentalFeatures()`.

## 0.12.1

### Patch Changes

- [#1349](https://github.com/MoonshotAI/kimi-code/pull/1349) [`e9db9ca`](https://github.com/MoonshotAI/kimi-code/commit/e9db9cafcf7a0d26122b2cac247d866d7724fd7a) - Record model response ids in session wire logs to make individual model requests easier to trace.

## 0.12.0

### Minor Changes

- [#1243](https://github.com/MoonshotAI/kimi-code/pull/1243) [`ace7901`](https://github.com/MoonshotAI/kimi-code/commit/ace79010669d19ad175bc25443b6efb41ca2e2ac) - Automatically compress oversized images before they reach the model. Whatever the source — pasted into the CLI, uploaded from the web/desktop client, sent over ACP, read via `ReadMediaFile`, or returned by an MCP tool — images are downsampled (longest edge ≤ 2000px) and re-encoded to fit a per-image byte budget, cutting vision-token cost and avoiding provider image-size errors. Screenshots stay lossless PNG and only degrade to JPEG when the byte budget cannot otherwise be met. Compression runs as an input-stage step at each ingestion point (while the content part is built), and guards against decompression bombs by skipping absurdly large pixel/byte payloads before decoding. Best-effort: if it fails for any reason the original image is sent unchanged.

## 0.11.0

### Minor Changes

- [#1132](https://github.com/MoonshotAI/kimi-code/pull/1132) [`108299b`](https://github.com/MoonshotAI/kimi-code/commit/108299be3cdffc31a23f64efd3ff5ba50976b412) - Refactor the thinking effort system

## 0.10.1

### Patch Changes

- [#1120](https://github.com/MoonshotAI/kimi-code/pull/1120) [`e736349`](https://github.com/MoonshotAI/kimi-code/commit/e736349a7c8ff55b73e05cc0192dfaf0114745fa) - Add optional feedback attachments for diagnostic logs and codebase context.

## 0.10.0

### Minor Changes

- [#812](https://github.com/MoonshotAI/kimi-code/pull/812) [`c0eeca2`](https://github.com/MoonshotAI/kimi-code/commit/c0eeca24692edd736eecd3c2541d7566bac9f80f) - Added the ability to add extra workspace directories:

  - Use the `/add-dir <path>` command to add extra working directories to the current session, or remember them for the project.
  - Use `kimi --add-dir <path>` to add them on startup.
  - Project-level local config is now managed in `.kimi-code/local.toml`; we recommend adding it to your `.gitignore`.

### Patch Changes

- [#821](https://github.com/MoonshotAI/kimi-code/pull/821) [`ba64072`](https://github.com/MoonshotAI/kimi-code/commit/ba64072559c1e9bb3447ede39991ac2e8bdb7645) - Allow long-running foreground commands and subagents to be moved into background tasks with Ctrl+B, and inspect them via the `/tasks` panel.

## 0.9.4

### Patch Changes

- [#838](https://github.com/MoonshotAI/kimi-code/pull/838) [`843a731`](https://github.com/MoonshotAI/kimi-code/commit/843a731097fc18b2e41ab0405b5fbcb6149ba55c) - Show the underlying connection error when OAuth token refresh fails after internal retries, instead of prompting for login. Token refresh failures are no longer re-retried at the agent loop level.

- [#625](https://github.com/MoonshotAI/kimi-code/pull/625) [`9a8fea5`](https://github.com/MoonshotAI/kimi-code/commit/9a8fea5c85177cd887896108c05ba9e174f28250) - Add host-side config helpers `loadRuntimeConfigSafe` and `resolveConfigPath` for inspecting config without spinning up a full KimiCore.

## 0.9.3

### Patch Changes

- [#689](https://github.com/MoonshotAI/kimi-code/pull/689) [`8d251f8`](https://github.com/MoonshotAI/kimi-code/commit/8d251f8ab44ead65f6c1bb264980ee7d075142ad) - Drop invalid config.toml sections with a warning instead of failing to start.

## 0.9.2

### Patch Changes

- [#648](https://github.com/MoonshotAI/kimi-code/pull/648) [`54302ad`](https://github.com/MoonshotAI/kimi-code/commit/54302ad612294056a47ada74b76737f2284861b5) - Prevent overlapping interactive agent requests from using the wrong active agent.

## 0.9.1

### Patch Changes

- [#591](https://github.com/MoonshotAI/kimi-code/pull/591) [`e48234a`](https://github.com/MoonshotAI/kimi-code/commit/e48234af576e41e630736450c66b690226707bc3) - Fix Windows builds and development launches that could fail when package binaries resolve to command shims.

## 0.9.0

### Minor Changes

- [#487](https://github.com/MoonshotAI/kimi-code/pull/487) [`4d11394`](https://github.com/MoonshotAI/kimi-code/commit/4d113949c8e906c20c7188817926f44786653923) - Honor the standard `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` environment variables, including SOCKS proxies, for all outbound traffic.

- [#424](https://github.com/MoonshotAI/kimi-code/pull/424) [`72c4b0a`](https://github.com/MoonshotAI/kimi-code/commit/72c4b0adaa6ae0466875cd8e4066c42456195f21) - Add the `/swarm` command for running agent swarms with live progress and rate-limit-aware retries.

### Patch Changes

- [#395](https://github.com/MoonshotAI/kimi-code/pull/395) [`879a7ee`](https://github.com/MoonshotAI/kimi-code/commit/879a7eeb33a8bedf18779d74a00d78369dae3db5) - Fix ACP slash skill routing, bootstrap context reads, file and permission edge cases, subagent event handling, and stale-file edit messaging.

- [#552](https://github.com/MoonshotAI/kimi-code/pull/552) [`db82e33`](https://github.com/MoonshotAI/kimi-code/commit/db82e33a20fd1ec204672df4ba5bc38800ce8dea) - Fix goal resume behavior by restoring goal state from agent records.

## 0.8.0

### Minor Changes

- [#420](https://github.com/MoonshotAI/kimi-code/pull/420) [`86a42a2`](https://github.com/MoonshotAI/kimi-code/commit/86a42a26a1e01f1748a937031fa76ebeaa1e28a8) - Add persistent experimental feature toggles and a TUI panel that applies confirmed changes by reloading the current session.

- [#383](https://github.com/MoonshotAI/kimi-code/pull/383) [`15d71b5`](https://github.com/MoonshotAI/kimi-code/commit/15d71b5130d949c35d9dc2641e807e08d72dce48) - Add /reload to reload the current session and apply updated config files, plus /reload-tui to reload only TUI preferences.

- [#431](https://github.com/MoonshotAI/kimi-code/pull/431) [`6a4e4c7`](https://github.com/MoonshotAI/kimi-code/commit/6a4e4c75d4bf6db3fefbb5c115d7a7c324bcae16) - Add a doctor command for validating Kimi Code configuration files.

### Patch Changes

- [#399](https://github.com/MoonshotAI/kimi-code/pull/399) [`232ed87`](https://github.com/MoonshotAI/kimi-code/commit/232ed874d41de777e6ff9c539ac22d830d0b5c3a) - Keep managed OAuth credentials scoped to their configured authentication and API endpoints.

- [#430](https://github.com/MoonshotAI/kimi-code/pull/430) [`be0da5f`](https://github.com/MoonshotAI/kimi-code/commit/be0da5ff39641e117d60045a43a7d5d2e0b85b75) - Fail early when Git Bash is missing on Windows before starting CLI sessions.

## 0.7.0

### Minor Changes

- [#338](https://github.com/MoonshotAI/kimi-code/pull/338) [`ba7dd73`](https://github.com/MoonshotAI/kimi-code/commit/ba7dd736a3b295b2a29c229a944208c232d51458) - Add `/btw` for side-channel conversations without steering the active main turn.

- [#339](https://github.com/MoonshotAI/kimi-code/pull/339) [`a6b16ce`](https://github.com/MoonshotAI/kimi-code/commit/a6b16ce6b4bdc20ed33888975c7da7ff1919e22f) - Allow SDK runtime creation to use a separate RPC client while preserving local CLI startup.

## 0.6.0

### Minor Changes

- [#270](https://github.com/MoonshotAI/kimi-code/pull/270) [`ac37d74`](https://github.com/MoonshotAI/kimi-code/commit/ac37d7448458fdb73fbe00e35856dcf44a13f734) - Add experimental goal mode for longer tasks that need more than one turn. Turn it on with `KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1` before you start Kimi.

  Use `/goal <objective>` in the TUI when you want Kimi to keep working on one task across turns. For example:

  ```text
  /goal Fix the failing checkout test
  ```

  Kimi shows the goal in the TUI and keeps progress visible while it works. Use `/goal status`, `/goal pause`, `/goal resume`, `/goal cancel`, and `/goal replace <objective>` to manage the goal. This feature is still experimental. Try it and tell us what would make it more useful.

- [#315](https://github.com/MoonshotAI/kimi-code/pull/315) [`191059d`](https://github.com/MoonshotAI/kimi-code/commit/191059d40049d3bfd07661ac03bb961eac1407f7) - Add background structured questions so agents can continue while waiting for user answers.

### Patch Changes

- [#145](https://github.com/MoonshotAI/kimi-code/pull/145) [`d912053`](https://github.com/MoonshotAI/kimi-code/commit/d912053b0d3983f4e67450c347616086cfbd1fe7) - Fix Git Bash path detection on Windows by also searching `usr\bin\bash.exe` locations, which is where bash lives in many Git for Windows installations where `bin\bash.exe` does not exist.

## 0.5.0

### Minor Changes

- [#204](https://github.com/MoonshotAI/kimi-code/pull/204) [`ee69d0a`](https://github.com/MoonshotAI/kimi-code/commit/ee69d0ac29f56bde4957c14767d7ca436697d9cf) - Render scheduled reminders distinctly in the TUI, expose cron fired events to SDK clients, and report cron fire times with local timezone offsets.

## 0.4.0

### Minor Changes

- [#221](https://github.com/MoonshotAI/kimi-code/pull/221) [`bab2da7`](https://github.com/MoonshotAI/kimi-code/commit/bab2da7b1c785d6deba25decb1411f8f5a70de8c) - Install plugins directly from GitHub repository URLs, and surface each install's origin and trust level (kimi-official, curated, third-party) in the plugin manager.

- [#118](https://github.com/MoonshotAI/kimi-code/pull/118) [`8913440`](https://github.com/MoonshotAI/kimi-code/commit/891344054111a05171963cfa524ef749c2855321) - Support querying sessions by sessionId or workDir in listSessions, and show a helpful cd command when resuming a session from a different working directory.

### Patch Changes

- [#221](https://github.com/MoonshotAI/kimi-code/pull/221) [`bab2da7`](https://github.com/MoonshotAI/kimi-code/commit/bab2da7b1c785d6deba25decb1411f8f5a70de8c) - Restrict plugin trust badges to Kimi-hosted plugin CDN URL patterns.

## 0.3.0

### Minor Changes

- [#119](https://github.com/MoonshotAI/kimi-code/pull/119) [`ebf6e81`](https://github.com/MoonshotAI/kimi-code/commit/ebf6e8181ea20a0fcf6a609195ccf5b6cc2a665a) - Add user-global plugin installation, interactive plugin management, plugin-provided skills, and plugin-owned MCP servers.

- [#113](https://github.com/MoonshotAI/kimi-code/pull/113) [`028d069`](https://github.com/MoonshotAI/kimi-code/commit/028d069b12d8377c5c307b94f11f02233d9c0a26) - Add `/export-md` slash command to export the current session as a Markdown file.

### Patch Changes

- [#105](https://github.com/MoonshotAI/kimi-code/pull/105) [`d599183`](https://github.com/MoonshotAI/kimi-code/commit/d599183c8eccea813d7aa5ddd974e72139cbb63c) - Enhance `kimi export` to include more diagnostic information in the manifest.

## 0.2.1

### Patch Changes

- [#70](https://github.com/MoonshotAI/kimi-code/pull/70) [`d95b013`](https://github.com/MoonshotAI/kimi-code/commit/d95b01342a7921f0863ceb37abad7984d0245509) - Preserve catalog-declared interleaved reasoning fields for OpenAI-compatible models configured through `/connect`.

## 0.2.0

### Minor Changes

- [#30](https://github.com/MoonshotAI/kimi-code/pull/30) [`a200a29`](https://github.com/MoonshotAI/kimi-code/commit/a200a297ac8986ec4baa8d2cdc881ef71bc3abfc) - Add a `/connect` command that configures a provider and model from a model catalog.

### Patch Changes

- [#33](https://github.com/MoonshotAI/kimi-code/pull/33) [`ab4bd09`](https://github.com/MoonshotAI/kimi-code/commit/ab4bd090825cffbd7ab656b47840b0060d6cf601) - Report the macOS product version in OAuth device information instead of the Darwin kernel version.

- [#49](https://github.com/MoonshotAI/kimi-code/pull/49) [`cf2227e`](https://github.com/MoonshotAI/kimi-code/commit/cf2227e8a5222ad9bd1167b573b62599d0efd906) - Resume sessions with a newer wire protocol version instead of failing. A warning is now shown in the TUI and records are replayed without migration.
