# @moonshot-ai/kimi-code-sdk

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
