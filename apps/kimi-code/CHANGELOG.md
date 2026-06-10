# @moonshot-ai/kimi-code

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
