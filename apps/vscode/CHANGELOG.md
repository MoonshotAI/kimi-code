# Changelog

## 0.6.5

### Patch Changes

- Updated dependencies [[`ec88d35`](https://github.com/MoonshotAI/kimi-code/commit/ec88d352e8f4dc5e8ffd1212f016138458f69893), [`b5efba7`](https://github.com/MoonshotAI/kimi-code/commit/b5efba7abcaf4041f81ec520097a61e6546e8c50), [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6), [`e458323`](https://github.com/MoonshotAI/kimi-code/commit/e45832398d0d9cad98dbad1cbf1e5b103a20aace)]:
  - @moonshot-ai/kimi-code-sdk@0.14.0

## 0.6.4

### Changed

- Picking a model's highest thinking effort now applies to the current session
  only instead of becoming the global default: the top tier saves just the
  on/off toggle, lower tiers persist as the default as before, and
  re-confirming the current effort no longer rewrites the saved preference.
  The model and thinking pickers also note that switching mid-conversation
  invalidates the existing prompt cache.
- Unified the YOLO and Auto permission mode naming and descriptions with the
  CLI (`/afk` is now `/auto`), and approval requests that fall outside the
  active permission mode (sensitive files, plan reviews, ask rules) are now
  always shown to you instead of being auto-approved.

## 0.6.3

### Fixed

- Editor mentions now work for files outside the working directory, and paths
  containing spaces are quoted correctly.
- Cancelling a running turn now reliably reaches the engine, and the UI no
  longer reports a task as stopped when there is nothing to cancel.
- Attaching to or resuming an existing session no longer overwrites its model
  and thinking effort with the configured defaults; model or effort changes
  picked in the composer are applied when the prompt is sent.

## 0.6.2

### Fixed

- A core error arriving in the middle of a turn no longer corrupts the active
  turn; the turn now ends cleanly with an error instead of leaving the chat in
  a broken state.
- Kimi sign-in and connection failures now include the underlying transport
  cause (for example DNS or connection refused) instead of a generic error.
- Closed several FetchURL SSRF bypasses and the DNS-rebinding window.
- Tool calls interrupted mid-stream are now recorded and closed, so they no
  longer corrupt the session history.

## 0.6.1

### Fixed

- The **Sign in** action in the settings (gear) menu now actually starts the
  Kimi login flow and shows an error toast when sign-in fails, instead of
  silently doing nothing.

## 0.6.0

### Breaking

- Raised the minimum supported editor version to VS Code 1.100.0.
- Legacy Kimi Code OAuth credentials and MCP OAuth credentials are deliberately
  not migrated. Sign in to Kimi Code again and re-authorize affected MCP
  servers after upgrading.
- Removed the `kimi.executablePath` and `kimi.environmentVariables` settings.
  The old `kimi.environmentVariables.KIMI_SHARE_DIR` value is consulted only to
  discover legacy data during migration; it is not applied to the new runtime.
  The system-level `KIMI_CODE_HOME` environment variable remains supported.

### Changed

- Replaced the legacy Python/stdio runtime with the in-process Kimi Code Node
  SDK. The extension no longer downloads or starts a separate Kimi executable.
- The in-process engine is the same one that powers the Kimi Code CLI, so the
  agent gains CLI-parity capabilities beyond the legacy runtime, including
  parallel subagent swarms, background tasks, and long-running goal runs.
- Added an opt-in legacy migration prompt on the first launch that detects data
  from version 0.5.x. The migration copies or merges supported data into the
  current Kimi Code home and does not delete the legacy source. If migration is
  skipped or needs to be retried, run **Kimi Code: Migrate Legacy Data** from the
  Command Palette.
- When VS Code and the Kimi Code terminal app resolve to the same
  `KIMI_CODE_HOME`, they use the same configuration and session storage. Running
  the same session concurrently from multiple processes is not supported or
  protected by cross-process locking.
- The model picker groups models by provider when multiple providers are
  configured, keeps provider identity when display names match, and recognizes
  adaptive-thinking metadata. A configured custom default provider no longer
  requires dismissing the Kimi account login screen on every launch.
- The file changes panel and Undo actions use extension-maintained baselines.
  Files changed through Kimi's Write and Edit operations are tracked on a
  best-effort basis. File deletions performed inside Bash are not tracked by
  this baseline and therefore cannot be restored by the panel's Undo action.

### Fixed

- The `kimi.yoloMode` setting now reaches the permission engine: enabling it
  maps to the core `yolo` permission mode and takes effect when a session
  attaches, including sessions that previously stored a disabled auto-approve
  state.
- Kept the chat header and input toolbar readable when the sidebar is narrow:
  controls wrap and shrink instead of being clipped.

### Distribution boundary

Release packaging produces target-specific VSIX files for `darwin-x64`,
`darwin-arm64`, `linux-x64`, `linux-arm64`, `win32-x64`, and `win32-arm64`.
Archive and static verification for a target does not by itself prove that the
extension has run successfully in that target's Extension Host; runtime test
results must be recorded separately for each operating system and architecture.
