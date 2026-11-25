# kimi-code-app

## 1.5.0

### Minor Changes

- [#5352](https://github.com/MoonshotAI/kimi-code/pull/5352) [`2b1b095`](https://github.com/MoonshotAI/kimi-code/commit/2b1b095f3bbf48e83632b0aaaabce6773caf4469) Thanks [@sailist](https://github.com/sailist)! - Add a "Swarm mode by default" toggle in Settings so new sessions start in swarm mode.

- [#5379](https://github.com/MoonshotAI/kimi-code/pull/5379) [`9fed8eb`](https://github.com/MoonshotAI/kimi-code/commit/9fed8ebe45aae5a78c7db266c165df79f3952544) Thanks [@sailist](https://github.com/sailist)! - Add a prompt prediction switch under Settings > Lab. Turn it on to see a predicted next prompt as the composer placeholder after a turn completes.

- [#5254](https://github.com/MoonshotAI/kimi-code/pull/5254) [`314a6bd`](https://github.com/MoonshotAI/kimi-code/commit/314a6bd96baa697b41bc4b26dbcc74419af7ebde) Thanks [@7Sageer](https://github.com/7Sageer)! - Remove the experimental `fork` parameter that let `Agent` and `AgentSwarm` start subagents with the caller's conversation history.

### Patch Changes

- [#5347](https://github.com/MoonshotAI/kimi-code/pull/5347) [`cafb392`](https://github.com/MoonshotAI/kimi-code/commit/cafb392f8341d578afd3b725a8df8b1a87a9fcb0) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix approval and question prompts occasionally not appearing while the session waits for an answer.

- [#5253](https://github.com/MoonshotAI/kimi-code/pull/5253) [`c0e9faf`](https://github.com/MoonshotAI/kimi-code/commit/c0e9faf0bda52462e034d938f41a3aa48a2e6426) Thanks [@7Sageer](https://github.com/7Sageer)! - Automatically approve statically verified read-only Bash commands in Always Ask mode. Add an `ask` permission rule to keep confirming them.

- [#5379](https://github.com/MoonshotAI/kimi-code/pull/5379) [`9fed8eb`](https://github.com/MoonshotAI/kimi-code/commit/9fed8ebe45aae5a78c7db266c165df79f3952544) Thanks [@sailist](https://github.com/sailist)! - Improve prompt prediction interactions.

- [#5159](https://github.com/MoonshotAI/kimi-code/pull/5159) [`9364a3f`](https://github.com/MoonshotAI/kimi-code/commit/9364a3f8b07ec085ef4f96cf586270659ca7d79b) Thanks [@kimi-agent-bot](https://github.com/kimi-agent-bot)! - Localize session occupied and session updated error messages.

- [#5143](https://github.com/MoonshotAI/kimi-code/pull/5143) [`09ddf45`](https://github.com/MoonshotAI/kimi-code/commit/09ddf45bbec6559451309d70444c021212c204d4) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Allow collapsing and expanding the sidebar Projects or Sessions section by clicking its header title or chevron.

- [#5093](https://github.com/MoonshotAI/kimi-code/pull/5093) [`5bc1f3e`](https://github.com/MoonshotAI/kimi-code/commit/5bc1f3e7b2903646e3519892a1eb1c937274e570) Thanks [@chengluyu](https://github.com/chengluyu)! - Add a Commands heading, skill icons, and keyboard hints to the / and @ menus, list / commands without the leading slash, label skills that come from plugins, show a searching state in place of outdated file results, and centre the key caps in the composer placeholder.

- [#5093](https://github.com/MoonshotAI/kimi-code/pull/5093) [`5bc1f3e`](https://github.com/MoonshotAI/kimi-code/commit/5bc1f3e7b2903646e3519892a1eb1c937274e570) Thanks [@chengluyu](https://github.com/chengluyu)! - Open the / menu when a message starts with 、, and the @ menu when @ directly follows Chinese, Japanese, or Korean text.

- [#5093](https://github.com/MoonshotAI/kimi-code/pull/5093) [`5bc1f3e`](https://github.com/MoonshotAI/kimi-code/commit/5bc1f3e7b2903646e3519892a1eb1c937274e570) Thanks [@chengluyu](https://github.com/chengluyu)! - Keep the / and @ menus closed after Esc until the / or @ is typed again, and close them when clicking outside.

- [#5093](https://github.com/MoonshotAI/kimi-code/pull/5093) [`5bc1f3e`](https://github.com/MoonshotAI/kimi-code/commit/5bc1f3e7b2903646e3519892a1eb1c937274e570) Thanks [@chengluyu](https://github.com/chengluyu)! - Show how to use @ and / in the message box placeholder.

- [#5093](https://github.com/MoonshotAI/kimi-code/pull/5093) [`5bc1f3e`](https://github.com/MoonshotAI/kimi-code/commit/5bc1f3e7b2903646e3519892a1eb1c937274e570) Thanks [@chengluyu](https://github.com/chengluyu)! - Tab in the / command menu now fills in the command name instead of running it. Press Enter to run it.

- [#5263](https://github.com/MoonshotAI/kimi-code/pull/5263) [`83a4dfc`](https://github.com/MoonshotAI/kimi-code/commit/83a4dfc24eac2b1b95d6a3481a2630f6c1657b9b) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Allow queuing context compaction from the context panel while a turn is running without showing a separate queued toast, show elapsed time beside the compaction status indicator, and render a token-delta summary card when compaction finishes.

- [#5058](https://github.com/MoonshotAI/kimi-code/pull/5058) [`638fd94`](https://github.com/MoonshotAI/kimi-code/commit/638fd94b6c22589253570b9b90dbe5359849ddc2) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Add Context usage, an experimental view of context usage and composition in the composer ring and session info sidebar, with a details panel listing each item the model receives. Turn it on in Settings → Lab.

- [#5391](https://github.com/MoonshotAI/kimi-code/pull/5391) [`5bd5009`](https://github.com/MoonshotAI/kimi-code/commit/5bd500987ed31a7278bfc59da043a6626172c46c) Thanks [@Grapedge](https://github.com/Grapedge)! - Add a Feedback item to the Help menu and align reply feedback buttons and tooltips with the copy and fork buttons.

- [#5369](https://github.com/MoonshotAI/kimi-code/pull/5369) [`f8375e1`](https://github.com/MoonshotAI/kimi-code/commit/f8375e18b74130ed82b7a314d10916e942c9f73b) Thanks [@markankamaransheogarat-sys](https://github.com/markankamaransheogarat-sys)! - Fix the built-in terminal failing on Windows for SSH remote projects by resolving `ssh.exe` to an absolute path before spawning `node-pty`.

- [#5262](https://github.com/MoonshotAI/kimi-code/pull/5262) [`1426175`](https://github.com/MoonshotAI/kimi-code/commit/142617544d8b36501671fe2deefe7303beb14aab) Thanks [@liruifengv](https://github.com/liruifengv)! - Edit the connected server’s global AGENTS.md in Settings → Agent & Sessions → Custom instructions.

- [#5194](https://github.com/MoonshotAI/kimi-code/pull/5194) [`992e3f1`](https://github.com/MoonshotAI/kimi-code/commit/992e3f16bbf06d1125e17bdccfbde84f32a87662) Thanks [@liruifengv](https://github.com/liruifengv)! - Show a localized error message when plugin authorization fails.

- [#5203](https://github.com/MoonshotAI/kimi-code/pull/5203) [`3d7f4c1`](https://github.com/MoonshotAI/kimi-code/commit/3d7f4c10e7967ebac6832b9cf17ebb3024d477f5) Thanks [@Grapedge](https://github.com/Grapedge)! - Fix MCP servers being started when archiving, deleting or forking a session that is not open.

- [#5261](https://github.com/MoonshotAI/kimi-code/pull/5261) [`9dadda1`](https://github.com/MoonshotAI/kimi-code/commit/9dadda17606cf2c44b5e9e6f0b2d2425edd4be4d) Thanks [@7Sageer](https://github.com/7Sageer)! - Send saved image and video filenames to the model provider, with their absolute paths in local execution environments.

- [#5068](https://github.com/MoonshotAI/kimi-code/pull/5068) [`31d776c`](https://github.com/MoonshotAI/kimi-code/commit/31d776c469b4b98a6d01a29f5c0d17b6825882e3) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Add an experimental Sessions entry to the @ menu for referencing other sessions in a message. Turn it on in Settings > Lab > Session mentions, then type @, open Sessions, and search by title, last message, or session ID.

- [#5330](https://github.com/MoonshotAI/kimi-code/pull/5330) [`fb790ad`](https://github.com/MoonshotAI/kimi-code/commit/fb790ad64a0cf67bad7dae14537e99c7337a9217) Thanks [@chengluyu](https://github.com/chengluyu)! - Fix the jump-to-latest button in the conversation stopping partway instead of reaching the bottom on mobile, especially in Safari.

- [#5370](https://github.com/MoonshotAI/kimi-code/pull/5370) [`82ace45`](https://github.com/MoonshotAI/kimi-code/commit/82ace45bdda95f7378e85701692a1e2a0b339101) Thanks [@liruifengv](https://github.com/liruifengv)! - Stop hover tooltips from opening and staying on screen after taps on touch devices.

- [#5199](https://github.com/MoonshotAI/kimi-code/pull/5199) [`942954f`](https://github.com/MoonshotAI/kimi-code/commit/942954fb510073832eaa397cb277c7bf2f39a021) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix menus that could reopen on their own right after being closed with Escape or a click outside.

- [#5113](https://github.com/MoonshotAI/kimi-code/pull/5113) [`e86127f`](https://github.com/MoonshotAI/kimi-code/commit/e86127f8b7a14264a2a3ce7c309e7e195baeda24) Thanks [@liruifengv](https://github.com/liruifengv)! - Fix conversation content shaking when switching from a session with the right panel open to one without it.

- [#5143](https://github.com/MoonshotAI/kimi-code/pull/5143) [`09ddf45`](https://github.com/MoonshotAI/kimi-code/commit/09ddf45bbec6559451309d70444c021212c204d4) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Add a display option in the sidebar Pinned section to toggle standalone pinned sessions between compact single-line rows and showing the project name underneath. Open it from the Pinned header options button or by right-clicking the Pinned header or empty space.

- [#5295](https://github.com/MoonshotAI/kimi-code/pull/5295) [`92ea0c6`](https://github.com/MoonshotAI/kimi-code/commit/92ea0c6dc3bf718c5a237e28db2d7e2c83978419) Thanks [@sailist](https://github.com/sailist)! - Fix approved plans being marked as failed tool calls in the conversation.

- [#5289](https://github.com/MoonshotAI/kimi-code/pull/5289) [`e42d4a5`](https://github.com/MoonshotAI/kimi-code/commit/e42d4a53b8b1fe73bbe5fde3ca142bfe4af3a5cf) Thanks [@7Sageer](https://github.com/7Sageer)! - Automatically reclaim session locks recorded under a different hostname. Shared state directories no longer protect live holders across machines or containers.

- [#5048](https://github.com/MoonshotAI/kimi-code/pull/5048) [`b695ed9`](https://github.com/MoonshotAI/kimi-code/commit/b695ed92af39e2da8a73833926604160071d8bf5) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Continue a failed turn in place without adding a synthetic "Continue" user message. Click Continue on the error card after a failed turn.

- [#5329](https://github.com/MoonshotAI/kimi-code/pull/5329) [`258379a`](https://github.com/MoonshotAI/kimi-code/commit/258379a2c67ead8f17f80a38be8343d971712d2a) Thanks [@chengluyu](https://github.com/chengluyu)! - Fix the conversation content jumping sideways when the right panel opens or closes while the session info sidebar is shown.

- [#5336](https://github.com/MoonshotAI/kimi-code/pull/5336) [`dee503c`](https://github.com/MoonshotAI/kimi-code/commit/dee503c506c8a0eee7bfc1e98344be21c29337b7) Thanks [@chengluyu](https://github.com/chengluyu)! - Fix conversations with image or video attachments sometimes failing to render and showing "Something went wrong".

- [#5258](https://github.com/MoonshotAI/kimi-code/pull/5258) [`972e750`](https://github.com/MoonshotAI/kimi-code/commit/972e750948b757e1efe26a40a2613f5163b42d91) Thanks [@liruifengv](https://github.com/liruifengv)! - Keep the selected sidebar view when opening a session from search results.

- [#5047](https://github.com/MoonshotAI/kimi-code/pull/5047) [`f9ee8bb`](https://github.com/MoonshotAI/kimi-code/commit/f9ee8bbf4dee5b12bb7ba66e5824dc5386e30c3b) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Add a stop button and double-Escape interrupt to side chats, prompt before closing non-empty or active side-chat tabs, and terminate the background side-chat agent on close.

- [#5190](https://github.com/MoonshotAI/kimi-code/pull/5190) [`1ef139e`](https://github.com/MoonshotAI/kimi-code/commit/1ef139e6c32a01c7ac51a89fea6ae279c91bc276) Thanks [@7Sageer](https://github.com/7Sageer)! - Show the current `[secondary_model]` model choices to the agent as soon as they change mid-session, without changing subagent tool definitions, and reject `model` when resuming an existing subagent instead of ignoring it.

- [#5352](https://github.com/MoonshotAI/kimi-code/pull/5352) [`2b1b095`](https://github.com/MoonshotAI/kimi-code/commit/2b1b095f3bbf48e83632b0aaaabce6773caf4469) Thanks [@sailist](https://github.com/sailist)! - Stop injecting the swarm-mode enter reminder into the conversation when swarm mode turns on.

- [#5260](https://github.com/MoonshotAI/kimi-code/pull/5260) [`0ab516e`](https://github.com/MoonshotAI/kimi-code/commit/0ab516efa7c920c04e62419a010fd56e627a746e) Thanks [@liruifengv](https://github.com/liruifengv)! - Place the Kimi Subscription first in the model picker provider tabs.

- [#5113](https://github.com/MoonshotAI/kimi-code/pull/5113) [`e86127f`](https://github.com/MoonshotAI/kimi-code/commit/e86127f8b7a14264a2a3ce7c309e7e195baeda24) Thanks [@liruifengv](https://github.com/liruifengv)! - Fix the reading position jumping when file change cards, code blocks, and images finish loading in a conversation.

- [#5375](https://github.com/MoonshotAI/kimi-code/pull/5375) [`48be878`](https://github.com/MoonshotAI/kimi-code/commit/48be8789ed80c2de3ad964bd85607e0591b3b6ae) Thanks [@chengluyu](https://github.com/chengluyu)! - Fix the selection quote menu disappearing after triple-clicking to select a paragraph.

- [#5221](https://github.com/MoonshotAI/kimi-code/pull/5221) [`ec6f58c`](https://github.com/MoonshotAI/kimi-code/commit/ec6f58c43baee56f392dd6b87ac68a31490cd51c) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Continue running sessions after restarting to install an update. The restart confirmation lists the sessions in progress and continues them after the restart unless you uncheck the option.

- [#5383](https://github.com/MoonshotAI/kimi-code/pull/5383) [`ecc92e3`](https://github.com/MoonshotAI/kimi-code/commit/ecc92e33841bc99d547df67aa152174fa8507368) Thanks [@sailist](https://github.com/sailist)! - Suppress completion notifications in the web and desktop apps between consecutive queued turns, while still notifying when background tasks remain running.

## 1.4.3

### Patch Changes

- [#5246](https://github.com/MoonshotAI/kimi-code/pull/5246) [`f81c924`](https://github.com/MoonshotAI/kimi-code/commit/f81c924b1d70f963b0dc094bcb6859e446c37a49) Thanks [@liruifengv](https://github.com/liruifengv)! - Show an authorization button in chat when an MCP connection needs browser sign-in.

- [#5300](https://github.com/MoonshotAI/kimi-code/pull/5300) [`fce3af9`](https://github.com/MoonshotAI/kimi-code/commit/fce3af9e694a5a572699546ebe8e28ccf004ed88) Thanks [@Grapedge](https://github.com/Grapedge)! - Rate individual replies or send feedback from the account menu or with `/feedback`.

- [#5212](https://github.com/MoonshotAI/kimi-code/pull/5212) [`2348f53`](https://github.com/MoonshotAI/kimi-code/commit/2348f531923616e250639bf66dcbf67c169ee4ab) Thanks [@kimi-agent-bot](https://github.com/kimi-agent-bot)! - Fix sessions that could not open after their model became unavailable.

- [#5197](https://github.com/MoonshotAI/kimi-code/pull/5197) [`0438be4`](https://github.com/MoonshotAI/kimi-code/commit/0438be4cc0f1b9509f18747472041b2210162e98) Thanks [@liruifengv](https://github.com/liruifengv)! - Detect plugin MCP OAuth requirements automatically and show the correct authorization state in plugin details.

## 1.4.2

### Patch Changes

- [#5191](https://github.com/MoonshotAI/kimi-code/pull/5191) [`7baee3c`](https://github.com/MoonshotAI/kimi-code/commit/7baee3cd9d74ac07efdf4a8587c19c1574fffbd2) Thanks [@chengluyu](https://github.com/chengluyu)! - Fix the draft thinking effort inherited from the global thinking setting reverting to the model default after sending.

## 1.4.1

### Patch Changes

- [#5161](https://github.com/MoonshotAI/kimi-code/pull/5161) [`55c7c7b`](https://github.com/MoonshotAI/kimi-code/commit/55c7c7befda7d907ad1cee3650d407415f78652e) Thanks [@kimi-agent-bot](https://github.com/kimi-agent-bot)! - Preserve the first prompt through project creation and sign-in prompts.

- [#5170](https://github.com/MoonshotAI/kimi-code/pull/5170) [`c2bec3f`](https://github.com/MoonshotAI/kimi-code/commit/c2bec3fb8e42aca9a7f7b3b80eff9dc1230d332c) Thanks [@liruifengv](https://github.com/liruifengv)! - Fix draft thinking effort selections reverting to the model default after sending.

- [#5165](https://github.com/MoonshotAI/kimi-code/pull/5165) [`170c729`](https://github.com/MoonshotAI/kimi-code/commit/170c729e5e83472eea276458cf7a6c65489b57a3) Thanks [@sailist](https://github.com/sailist)! - Fix turn-specific fork failures after restoring sessions with in-turn steering.

- [#5174](https://github.com/MoonshotAI/kimi-code/pull/5174) [`3ad2547`](https://github.com/MoonshotAI/kimi-code/commit/3ad25477c23663822c3f0f0ecabe0db514ebcd1e) Thanks [@7Sageer](https://github.com/7Sageer)! - Merge "Select this folder" into the primary button in the folder picker.

## 1.4.0

### Minor Changes

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Connect external agents such as Claude Code, Codex, and Cursor to this desktop app to hand off sessions, review history, and collaborate across turns.

### Patch Changes

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Show background task notifications as collapsible rows styled like tool calls, with correct task duration and status.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Expose `KIMI_CODE_SESSION_ID` and `KIMI_CODE_WORKSPACE_ID` to shell tool subprocesses.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Fix annotations not working on local HTML files in the built-in browser.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Fix the built-in browser being flagged as insecure when signing in on some websites.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Browser tabs (including the remote control page) now show a dynamic favicon, and the tab title displays the project and current session, configurable in Settings > Appearance.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Select regions, rows, or columns in Markdown tables and copy them via right-click or keyboard shortcuts.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Move the browser tab title preview below the setting and show a single tab.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Shrink the screenshot magnifier and color picker so they cover less of the screen.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Add Qwen Coding Plan (global and China sites) as selectable providers.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Fix image load failures potentially triggering auth rate limits.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Fix the model and permission popups overflowing the screen on narrow and mobile layouts.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Fix duplicate unread/read state on earlier steered messages when steering multiple times in a row.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Fix known issues in session resume, background notifications, model responses, and Windows WebBridge updates.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Fix repeated cryptic "action failed" toasts when opening the model picker with an expired provider credential.

- [#5098](https://github.com/MoonshotAI/kimi-code/pull/5098) [`63b94bc`](https://github.com/MoonshotAI/kimi-code/commit/63b94bc4c0169bf362dac2071990596933f6c959) Thanks [@kimi-agent-bot](https://github.com/kimi-agent-bot)! - Fix table action buttons being clipped when the side chat is open.

- [#5102](https://github.com/MoonshotAI/kimi-code/pull/5102) [`0b73b62`](https://github.com/MoonshotAI/kimi-code/commit/0b73b629dea1a8918813d2e3eb46bb597a5dad32) Thanks [@7Sageer](https://github.com/7Sageer)! - Keep local projects visible when an SSH host stops responding and fix loading older project sessions in the sidebar.

- [#5090](https://github.com/MoonshotAI/kimi-code/pull/5090) [`08997af`](https://github.com/MoonshotAI/kimi-code/commit/08997afe2b49b67f790cecb7c2c6a8fab86c40af) Thanks [@liruifengv](https://github.com/liruifengv)! - Show the update button when the browser extension reports an update while in the partial state.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Fix the bottom edge of CJK subscripts being clipped in block math.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Highlight the "send while running" setting when jumping to it from the composer hint bar.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Add mark as unread/read to the session context menu.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Fix the hover tooltip collapsing into a small dot when renaming a pinned session.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Support pinning projects in the sidebar's pinned section, with single-row display and drag-to-reorder alongside pinned sessions.

- [#5037](https://github.com/MoonshotAI/kimi-code/pull/5037) [`3a05a7e`](https://github.com/MoonshotAI/kimi-code/commit/3a05a7ec93f30b7771c101661d21ce1f5b2f2435) Thanks [@sailist](https://github.com/sailist)! - Fix remote control connections ignoring the system HTTP/HTTPS proxy environment variables.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Restore the directory row and action buttons in the new project dialog; the full path now shows on hover.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Messages sent while the agent is running now steer the current turn immediately by default, with a first-time hint; switch back to queueing in Settings.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Fix the macOS IME candidate window being hidden behind the screenshot overlay.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Connect to SSH hosts and create projects on them. Each host uses its own Kimi account, and remote sessions keep running while this machine is asleep or offline.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Show the current session ID in the session status dialog.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Use square stop icons for background tasks and keep completed, failed, and stopped states in the task bar.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Fix stopping a session waking up sessions that were already closed.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Unify button styles and interactions across the app.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Unify the style of undo, archive, delete, and export toasts and show them centered at the top.

- [#5079](https://github.com/MoonshotAI/kimi-code/pull/5079) [`5db75e0`](https://github.com/MoonshotAI/kimi-code/commit/5db75e0c20dd74fa92225f26c95116fcc4594cb1) Thanks [@liruifengv](https://github.com/liruifengv)! - Support creating a new folder directly while picking a directory when adding a project.

## 1.3.7

### 新功能

- 支持为自定义模型服务商配置搜索和反馈地址。

### 修复

- 修复后台通知导致 Tower 任务意外停止的问题。
- 修复每轮回复完成后外部 Stop 钩子未执行的问题。
- 修复恢复或创建会话分支时后台任务通知意外触发新回复的问题。
- 修复 Windows 上 WebBridge 守护进程运行时无法更新的问题。
- 修复了若干已知的问题。

## 1.3.6

### 修复

- 修复会话加载失败后界面可能卡死的问题。
- 修复重新打开包含大量工具调用的长会话时加载卡顿数秒的问题。
- 修复工具结果含备注、错误或时间头时长会话无法压缩的问题。
- 修复失败或未完成的 Kimi 媒体上传被缓存复用的问题。
- 修复加载会话历史消息时画面上下跳动的问题。
- 修复关闭内置浏览器控制后无法使用其他工具的问题。
- 修复对话中代码块点击开启自动换行后不生效的问题。

## 1.3.5

### 修复

- 修复重新打开长会话时加载卡顿数秒的问题。

## 1.3.4

### 新功能

- 支持自定义界面、对话、代码和终端字体，并提供内置字体。
- 输入框粘贴长文本自动折叠，可点击查看和编辑。
- @ 提及文件支持搜索 .gitignore 忽略的文件。
- 终端标签支持拖拽排序，可在底部与右侧面板间移动。
- 截图新增放大镜与取色功能。
- 内置浏览器支持打开本地文件，标签页默认静音。
- 支持更换项目主目录。
- 自定义模型支持导入 Google GenAI 服务商。

### 修复

- 修复断线重连、网络波动及模型重试时的对话更新异常。
- 修复会话恢复、撤回消息与运行中插话时的状态同步问题。
- 修复停止对话及应用升级后的工具调用异常。
- 修复特殊路径文件预览失败、误触鼠标返回键卡住等界面问题。
- 修复其他已知问题，并优化多处使用体验。

## 1.3.3

### 优化

- 优化 steer 插话逻辑。

### 修复

- 修复闲置会话再次发送消息时只显示“请求中”的问题。
- 修复 Windows 上 npx 等脚本命令配置的 MCP 服务器启动失败。

## 1.3.2

### 修复

- 修复运行中发送插话时消息被错误排队的问题。
- 修复 MCP 工具定义变化时出现重复工具声明错误的问题。

## 1.3.1

### 修复

- 修复更新后启动时正常界面被错误页面覆盖的问题。
- 修复空系统消息导致会话反复请求失败的问题。
- 修复回答过程中工具调用汇总反复展开和收起的问题。
- 修复图片和视频工具结果在实时及历史消息中无法预览的问题。
- 修复新会话首轮对话后不自动生成标题的问题。
- 修复包含空格的本地图片路径无法显示的问题。
- 修复窄屏下信息面板自动悬浮并遮挡聊天消息的问题。
- 修复已删除工作区的会话仍出现在会话列表中的问题。
- 修复出现旧的空工作区的问题。

## 1.3.0

### 新功能

- 支持创建项目，可以在项目中添加多个工作目录。
- 新增右侧会话信息面板，集中查看会话详情。
- 新增诊断信息导出，可打包日志与崩溃报告。
- 支持从任意历史轮次分叉会话，支持运行中分叉。
- 可允许正在运行的子智能体控制内置浏览器。
- Desktop 支持用系统默认应用打开 Markdown 文档。
- 文件树支持展开软链接目录。

### 优化

- 优化插件市场 UI 和交互。
- 界面、代码和终端改用系统字体。
- 对话目录移至左侧，优化 UI 和交互。
- 电脑操作与工具选择调用显示易读标题、参数和结果摘要。
- 后台提问默认折叠，回答后直接展示问题与答案。
- 后台任务面板聚焦运行中任务，详情输出实时累积。
- 子智能体模型设置新增“跟随默认模型”选项。
- 排队消息改为按会话当前权限模式执行。
- 启动时显示加载页面，可直接导出诊断信息或重启应用。
- 右侧面板打开时会话信息默认收起，仍可手动展开。

### 修复

- 修复启动失败、内部错误弹窗卡死及界面异常退出后黑屏的问题。
- 修复 Windows 版在后台阻止电脑自动息屏的问题。
- 修复部分 Windows 电脑无法使用截屏功能的问题。
- 修复 Windows 多处文件路径显示与模型识别异常的问题。
- 修复 Windows 附件重复打开入口及终端退出偶发崩溃的问题。
- 修复审批反馈、已输入内容及多步问答进度偶尔被重置的问题。
- 修复长会话历史翻页停止、位置跳变、重复加载及加载超时的问题。
- 修复长会话与流式输出时的界面冻结和持续卡顿的问题。
- 修复后台续跑及切换会话后回答折叠或停止实时更新的问题。
- 修复侧聊首答串入主会话及历史消息丢失、乱序的问题。
- 修复右侧面板空白、卡顿、刷新异常及最新消息按钮偏移的问题。
- 修复粘贴大段文本后卡顿及图片链接被误当本地文件的问题。
- 修复带行号文件引用无法打开及斜杠菜单误切换选中项的问题。
- 修复标题栏复制及打开外部链接、保存截图时的异常。
- 修复设置子智能体模型后，仍可能回退使用主模型的问题。
- 修复自定义模型注册表导入、刷新及 MCP 工具列表异常的问题。
- 修复睡眠唤醒或网络变化时后台更新可能弹出错误框的问题。
- 修复部分图片、行内公式及设备模拟导致的显示异常或崩溃。
- 修复多目录项目中根目录切换、文件预览及重复目录提示异常的问题。
- 修复设置中按 Esc 无法关闭及流式输出时界面控件异常的问题。
- 修复窄窗口布局及远程控制冲突弹窗按钮被裁切的问题。
- 修复撤销消息后待办列表没有同步回退的问题。

### 其他

- 最低支持的 macOS 版本提高到 13，macOS 12 不再收到更新。

## 1.2.1

### 优化

- 减少读取长中文文件时的上下文占用。
- 优化内置提示词。

## 1.2.0

### 新功能

- 新增防止休眠功能，可在设置 → 通用中开启。
- 支持直接删除归档会话，入口在设置 → 已归档的会话。
- 支持粘贴图片时自动提及，可在设置 → 智能体与会话 → 输入框中开启。

### 优化

- steer 消息增加未读、已读和插入进度提示。
- 优化上翻或加载历史消息时阅读位置跳动的体验。
- 新建会话时可打开文件树并预览工作区文件。

### 修复

- 修复空白会话时 Swarm 模式不生效的问题。
- 修复长对话自动压缩时历史缓存失效的问题。
- 修复内置浏览器崩溃、点击失败和缩放显示异常等问题。

## 1.1.4

### 优化

- 优化模型切换提示。
- 开启 Swarm 模式时不再弹出确认框，直接开启并提示高消耗。

### 修复

- 修复未开启 Swarm 模式时，Agent 发起 Swarm 会显示失败卡片。

## 1.1.3

### 优化

- Agent 默认自己完成任务，需要委派时请明确要求或开启 swarm 模式。
- Agent 不再自行发起 swarm，只有开启 swarm 模式后才会运行。

## 1.1.2

### 新功能

- 会话被占用且重试后仍被占用时，可以选择接管会话。

### 优化

- 会话被占用时，显示正在使用该会话的客户端名称。

### 修复

- 修复 Windows 缺少 Git Bash 时工作区信任检查失败的问题。

## 1.1.1

### 新功能

- 新增工作区信任确认：打开未信任的文件夹时会提示是否信任，拒绝后无法发送消息。
- 切换模型时弹出确认，可选择新建会话、压缩后继续或直接继续。
- 支持在 agent 运行期间排队 /compact 命令，轮到它时自动执行。
- 新增会话重新加载，立即应用外部的 AGENTS.md、技能和配置变更。
- 同一会话在多个客户端打开时，会弹出占用确认框并可一键重试。

### 优化

- 文件树面板可放在左侧或右侧，并更换了开关按钮图标。

### 修复

- 修复长对话流式输出时界面卡顿、电脑发热的问题。
- 修复发送失败时文字、附件和排队中的消息可能丢失的问题。
- 修复 Windows 上 kimi app 无法打开工作区或唤醒桌面端、新会话卡在加载的问题。

## 1.1.0

### 新功能

- 新增 Linux 版本，提供 AppImage、deb、RPM 安装包。
- 新增远程控制（设置 → 远程控制 开启）：通过链接或二维码从其他设备控制本机智能体。
- 右侧栏新增文件树面板，可浏览工作区文件并点击预览。
- 新增「进展更新」：在对话中查看 agent 的实时工作进展（默认关闭，可在 设置 → 实验室 开启）。
- 新增 `kimi app` 命令：在终端中运行即可唤起桌面端，在当前或指定目录开始新会话。

### 优化

- 内置浏览器多项改进：新增下载进度，智能体可接管网页弹窗，可暂停其控制。
- 智能体等待后台任务时，排队和新发送的消息会立即送达。

### 修复

- 修复部分 Mac 上聊天内容包含 emoji 时界面崩溃的问题。
- 修复大文件无法查看逐行差异及差异计算卡顿的问题。
- 修复侧边聊天向上滚动查看历史会被拉回底部的问题。
- 修复多处界面问题：小屏对话目录不显示、@ 菜单文件名竖排、毛玻璃背景不透明。

## 1.0.4

### Patch Changes

- [#797](https://github.com/MoonshotAI/kimi-code-app/pull/797) [`3051a07`](https://github.com/MoonshotAI/kimi-code-app/commit/3051a07fb44860cfc531668c105e433987dc5346) - 修复信任工作区后，仓库自带的 Git 配置（如 hooks）不生效、符号链接目录和项目级 local.toml 无法使用的问题。

- [#797](https://github.com/MoonshotAI/kimi-code-app/pull/797) [`3051a07`](https://github.com/MoonshotAI/kimi-code-app/commit/3051a07fb44860cfc531668c105e433987dc5346) - 恢复默认监听工作区文件变化，在应用外修改配置或 AGENTS.md 后自动生效。

## 1.0.3

### Patch Changes

- [#770](https://github.com/MoonshotAI/kimi-code-app/pull/770) [`732e650`](https://github.com/MoonshotAI/kimi-code-app/commit/732e6503864ac7cd2199f825f66f59051f03e32e) - 设置中新增自动生成会话标题开关，关闭后不再用 AI 命名新会话。

- [#776](https://github.com/MoonshotAI/kimi-code-app/pull/776) [`3f60b29`](https://github.com/MoonshotAI/kimi-code-app/commit/3f60b29e62f8de377311c621d909903bac56d72a) - 修复 Fork 会话继续聊天后标题被自动重新生成覆盖的问题。

- [#781](https://github.com/MoonshotAI/kimi-code-app/pull/781) [`95ea051`](https://github.com/MoonshotAI/kimi-code-app/commit/95ea0512dc489f520d1f52c51960fc284e3e6d91) - 修复展开命令行工具调用时看不到完整命令、且命令输出被误标为 Bash 的问题。

- [#736](https://github.com/MoonshotAI/kimi-code-app/pull/736) [`73e50c4`](https://github.com/MoonshotAI/kimi-code-app/commit/73e50c4de4cd821eecf6d92841a473367132da34) - 内置浏览器地址栏联想会加粗与输入匹配的文字，合并指向同一网页的重复建议，并在网址相似时显示它们不同的部分。

- [#744](https://github.com/MoonshotAI/kimi-code-app/pull/744) [`6d7da93`](https://github.com/MoonshotAI/kimi-code-app/commit/6d7da9303b19f4a22e0697d943d2d1242f0384a2) - 清空下载记录按钮移到下载内容列表顶部的刷新按钮旁边。

- [#744](https://github.com/MoonshotAI/kimi-code-app/pull/744) [`6d7da93`](https://github.com/MoonshotAI/kimi-code-app/commit/6d7da9303b19f4a22e0697d943d2d1242f0384a2) - 下载内容列表中已完成的下载重新显示文件大小。

- [#744](https://github.com/MoonshotAI/kimi-code-app/pull/744) [`6d7da93`](https://github.com/MoonshotAI/kimi-code-app/commit/6d7da9303b19f4a22e0697d943d2d1242f0384a2) - 下载内容列表支持暂停、继续和取消正在进行的下载，中断后可继续的下载也能直接继续。

- [#744](https://github.com/MoonshotAI/kimi-code-app/pull/744) [`6d7da93`](https://github.com/MoonshotAI/kimi-code-app/commit/6d7da9303b19f4a22e0697d943d2d1242f0384a2) - 下载内容列表按日期分成独立卡片，日期分组更清楚。

- [#744](https://github.com/MoonshotAI/kimi-code-app/pull/744) [`6d7da93`](https://github.com/MoonshotAI/kimi-code-app/commit/6d7da9303b19f4a22e0697d943d2d1242f0384a2) - 下载内容列表可以重试已中断的下载，应用重启前中断的下载也能从断点继续。

- [#744](https://github.com/MoonshotAI/kimi-code-app/pull/744) [`6d7da93`](https://github.com/MoonshotAI/kimi-code-app/commit/6d7da9303b19f4a22e0697d943d2d1242f0384a2) - 加大下载内容列表中文件名和状态两行之间的间距，更易阅读。

- [#744](https://github.com/MoonshotAI/kimi-code-app/pull/744) [`6d7da93`](https://github.com/MoonshotAI/kimi-code-app/commit/6d7da9303b19f4a22e0697d943d2d1242f0384a2) - 下载内容列表为进行中的下载显示下载速度和剩余时间。

- [#789](https://github.com/MoonshotAI/kimi-code-app/pull/789) [`b367f9e`](https://github.com/MoonshotAI/kimi-code-app/commit/b367f9e03b43520742865ddb26e0d1951190fbc3) - 修复删除会话后确认弹窗一直转圈无法关闭的问题。

- [#781](https://github.com/MoonshotAI/kimi-code-app/pull/781) [`95ea051`](https://github.com/MoonshotAI/kimi-code-app/commit/95ea0512dc489f520d1f52c51960fc284e3e6d91) - 代码块滚动条在未悬停时颜色更淡。

- [#756](https://github.com/MoonshotAI/kimi-code-app/pull/756) [`0696e65`](https://github.com/MoonshotAI/kimi-code-app/commit/0696e65899a19051cee55c92178bf2711dfc9186) - 删除定时任务的记录支持查看时间规则、提示词和重复方式。

- [#756](https://github.com/MoonshotAI/kimi-code-app/pull/756) [`0696e65`](https://github.com/MoonshotAI/kimi-code-app/commit/0696e65899a19051cee55c92178bf2711dfc9186) - 定时任务在对话记录和触发提醒中显示易读的名称、周期和详情，不再直接展示 Cron 表达式和原始参数。

- [#783](https://github.com/MoonshotAI/kimi-code-app/pull/783) [`c114172`](https://github.com/MoonshotAI/kimi-code-app/commit/c114172b5cbac645c226d8a655303586c28b9adf) - 右键点击会话中的文件名，可以复制路径或在文件夹中显示。

- [#730](https://github.com/MoonshotAI/kimi-code-app/pull/730) [`44d7281`](https://github.com/MoonshotAI/kimi-code-app/commit/44d7281c7a63ee3c7a907f9406e490efdbec7411) - 修复恶意网页可通过本地内嵌服务器执行任意命令的安全漏洞。

- [#726](https://github.com/MoonshotAI/kimi-code-app/pull/726) [`a8e559b`](https://github.com/MoonshotAI/kimi-code-app/commit/a8e559b29d7e0037edf31f75d5f80ed386e022c9) - 修复点击聊天中的本地文件链接会让应用窗口跳离当前界面的问题。

- [#769](https://github.com/MoonshotAI/kimi-code-app/pull/769) [`4f76257`](https://github.com/MoonshotAI/kimi-code-app/commit/4f762576d6ca60570c8f71cbdc027b5f44fda68f) - 修复打开或展开内容较多的长对话时界面长时间卡死的问题。

- [#768](https://github.com/MoonshotAI/kimi-code-app/pull/768) [`300a66f`](https://github.com/MoonshotAI/kimi-code-app/commit/300a66f6f24224bae154896be22731d7c720d46e) - 修复开启消息自动折叠后，后台任务完成通知在对话中显示位置错乱的问题。

- [#772](https://github.com/MoonshotAI/kimi-code-app/pull/772) [`d17a851`](https://github.com/MoonshotAI/kimi-code-app/commit/d17a851d14f032be566c888c74459911513ccf53) - 修复 Windows 截图贴图拖动时尺寸持续变大或弹出错误的问题。

- [#493](https://github.com/MoonshotAI/kimi-code-app/pull/493) [`e91eb8c`](https://github.com/MoonshotAI/kimi-code-app/commit/e91eb8c369b8e015b9c6ea9578d5958a981a33e7) - 在输入框中高亮有效的行首命令，并在未输入参数时显示参数提示。

- [#726](https://github.com/MoonshotAI/kimi-code-app/pull/726) [`a8e559b`](https://github.com/MoonshotAI/kimi-code-app/commit/a8e559b29d7e0037edf31f75d5f80ed386e022c9) - HTML 文件预览工具栏新增「在系统浏览器打开」和「在侧边面板浏览器打开」按钮。

- [#755](https://github.com/MoonshotAI/kimi-code-app/pull/755) [`87b01d5`](https://github.com/MoonshotAI/kimi-code-app/commit/87b01d52a899eda09fd34be65762ef1f237ec429) - 聊天中的 Markdown 表格现在带有圆角外框和列分隔线，单元格内边距更紧凑，加宽与复制按钮位于表格外侧。

- [#741](https://github.com/MoonshotAI/kimi-code-app/pull/741) [`022387c`](https://github.com/MoonshotAI/kimi-code-app/commit/022387c1d15ffbe410185a20d997cf2d2f96e174) - 对话内任务清单的复选框图标从蓝色改为中性灰样式。

- [#782](https://github.com/MoonshotAI/kimi-code-app/pull/782) [`58e26a2`](https://github.com/MoonshotAI/kimi-code-app/commit/58e26a278d23811ca75d47cc94ce288dcd881574) - 修复移动端长对话一次渲染过多内容导致内存占用过高的问题。

- [#726](https://github.com/MoonshotAI/kimi-code-app/pull/726) [`a8e559b`](https://github.com/MoonshotAI/kimi-code-app/commit/a8e559b29d7e0037edf31f75d5f80ed386e022c9) - 在聊天里点击 @ 提及或 Markdown 链接中的本地 HTML 文件，会在右侧内置浏览器中按真实网页打开，脚本和同目录的样式、脚本、图片都能正常加载。

- [#762](https://github.com/MoonshotAI/kimi-code-app/pull/762) [`f017b3b`](https://github.com/MoonshotAI/kimi-code-app/commit/f017b3bf03f3ea2e0c48a712cf6daa7b1be746b4) - 修复长对话中流式输出时界面卡顿掉帧的问题。

- [#790](https://github.com/MoonshotAI/kimi-code-app/pull/790) [`5996327`](https://github.com/MoonshotAI/kimi-code-app/commit/59963273666a4ddaca53711057573362fb1923c6) - 修复设置界面子代理模型与配置文件键名不一致的问题：手动在配置文件里设置子代理模型后界面仍显示未配置，且在界面保存后配置不生效。

- [#686](https://github.com/MoonshotAI/kimi-code-app/pull/686) [`b0fa9d6`](https://github.com/MoonshotAI/kimi-code-app/commit/b0fa9d61ac0395fddd78ba073db3ab7dc2fdcaa6) - 修复窗口较窄时打开右侧面板，左侧边栏先被挤走又弹回、且原有宽度被改小的问题。

- [#779](https://github.com/MoonshotAI/kimi-code-app/pull/779) [`2077bf2`](https://github.com/MoonshotAI/kimi-code-app/commit/2077bf2c273729495f9d97c501980af42b3efda3) - 新会话空状态下，侧边聊天入口、快捷键和 /btw 命令改为禁用。

- [#784](https://github.com/MoonshotAI/kimi-code-app/pull/784) [`be4a7ab`](https://github.com/MoonshotAI/kimi-code-app/commit/be4a7ab520a5207acc4dbd64f235a4e8f7e03cfe) - 修复侧边聊天请求失败时不显示任何错误提示的问题。

- [#754](https://github.com/MoonshotAI/kimi-code-app/pull/754) [`228569e`](https://github.com/MoonshotAI/kimi-code-app/commit/228569e351029975ef869ea55d1bab0cbe62e963) - 缩小并行子任务列表的行间距和内边距。

- [#754](https://github.com/MoonshotAI/kimi-code-app/pull/754) [`228569e`](https://github.com/MoonshotAI/kimi-code-app/commit/228569e351029975ef869ea55d1bab0cbe62e963) - 修复重新打开会话后被中断的 Swarm 成员没有显示真实状态的问题。

- [#754](https://github.com/MoonshotAI/kimi-code-app/pull/754) [`228569e`](https://github.com/MoonshotAI/kimi-code-app/commit/228569e351029975ef869ea55d1bab0cbe62e963) - 修复历史会话里已结束的并行子任务无法查看结果的问题。

- [#754](https://github.com/MoonshotAI/kimi-code-app/pull/754) [`228569e`](https://github.com/MoonshotAI/kimi-code-app/commit/228569e351029975ef869ea55d1bab0cbe62e963) - 修复 Swarm 工具卡片的一系列显示问题：身份误标为子代理、无数据蓝点、冗余已保存结果区、标题被过度截断、边框过淡；成员列表新增滚动渐隐与悬浮滚动条，成员出错时改为错误图标加悬浮提示。

- [#754](https://github.com/MoonshotAI/kimi-code-app/pull/754) [`228569e`](https://github.com/MoonshotAI/kimi-code-app/commit/228569e351029975ef869ea55d1bab0cbe62e963) - 修复排队或暂停的子任务错误显示为进行中的问题。

- [#755](https://github.com/MoonshotAI/kimi-code-app/pull/755) [`87b01d5`](https://github.com/MoonshotAI/kimi-code-app/commit/87b01d52a899eda09fd34be65762ef1f237ec429) - 修复拖动表格列分隔线会把整个表格拉宽、出现横向滚动条的问题。

- [#755](https://github.com/MoonshotAI/kimi-code-app/pull/755) [`87b01d5`](https://github.com/MoonshotAI/kimi-code-app/commit/87b01d52a899eda09fd34be65762ef1f237ec429) - 加宽表格现在占满会话整宽，加宽期间右侧目录自动隐藏；横向滚动时左右两侧都会淡出提示还有内容。

- [#755](https://github.com/MoonshotAI/kimi-code-app/pull/755) [`87b01d5`](https://github.com/MoonshotAI/kimi-code-app/commit/87b01d52a899eda09fd34be65762ef1f237ec429) - 表格的横向滚动条改为覆盖式，不再撑高表格，未与表格交互时隐藏。

- [#786](https://github.com/MoonshotAI/kimi-code-app/pull/786) [`d244166`](https://github.com/MoonshotAI/kimi-code-app/commit/d244166de1e9905b8982fe5cab6c1369bc7bc144) - 修复焦点在终端时按 Cmd+K 误弹出搜索面板的问题。

- [#787](https://github.com/MoonshotAI/kimi-code-app/pull/787) [`69c6f10`](https://github.com/MoonshotAI/kimi-code-app/commit/69c6f10a13c3eef3f80a13a3407edfadae1557fe) - 修复 Windows 内置终端选中文字后按 Ctrl+C 仍中断进程、无法复制的问题。

- [#779](https://github.com/MoonshotAI/kimi-code-app/pull/779) [`2077bf2`](https://github.com/MoonshotAI/kimi-code-app/commit/2077bf2c273729495f9d97c501980af42b3efda3) - 右侧面板启动器的终端条目现在显示快捷键。

## 1.0.2

### Patch Changes

- [#753](https://github.com/MoonshotAI/kimi-code-app/pull/753) [`6c1569f`](https://github.com/MoonshotAI/kimi-code-app/commit/6c1569f7ed4dbc62fe256ca8771aaaa7b76a8cff) - 命令运行中的活动提示不再显示完整命令内容。

- [#693](https://github.com/MoonshotAI/kimi-code-app/pull/693) [`b2a1bf8`](https://github.com/MoonshotAI/kimi-code-app/commit/b2a1bf8c91514df5eddb8494f5b7d74d21de6bbf) - Agent 在内置浏览器中点击、输入等操作前会保存一张局部截图，可以在对话里查看每一步当时的页面。

- [#705](https://github.com/MoonshotAI/kimi-code-app/pull/705) [`a01a955`](https://github.com/MoonshotAI/kimi-code-app/commit/a01a95526c6b46b0f55b67c246e86144ca21e951) - Agent 使用内置浏览器时，工具分组标题会写出正在做的事和浏览了哪些页面；自己恢复的失败合成一行并标明重试次数；回答下方列出本次读过的网页，可直接打开；面板收起时可一键查看 Agent 正在操作的网页。

- [#713](https://github.com/MoonshotAI/kimi-code-app/pull/713) [`57f21b8`](https://github.com/MoonshotAI/kimi-code-app/commit/57f21b802f60198c3dc29ec44140525ac2fb6829) - 修复内置浏览器地址栏输入时联想列表每按一个键就闪烁的问题。

- [#740](https://github.com/MoonshotAI/kimi-code-app/pull/740) [`c1cacdd`](https://github.com/MoonshotAI/kimi-code-app/commit/c1cacdd835033216c989c34face7d51480f7afb4) - 修复智能体读取网页文字时因范围参数格式不对而反复失败的问题。

- [#738](https://github.com/MoonshotAI/kimi-code-app/pull/738) [`395d4da`](https://github.com/MoonshotAI/kimi-code-app/commit/395d4da1ede9e741d4303ba720e3ad8c90fb1884) - 智能体可以在内置浏览器中用设置里选择的搜索引擎搜索网页。

- [#737](https://github.com/MoonshotAI/kimi-code-app/pull/737) [`778f2d5`](https://github.com/MoonshotAI/kimi-code-app/commit/778f2d540b5aa7ec3efe45a332daefec17ccd1bd) - 修复智能体打开网页时网址被截断成无效字符、变成错误搜索的问题。

- [#693](https://github.com/MoonshotAI/kimi-code-app/pull/693) [`b2a1bf8`](https://github.com/MoonshotAI/kimi-code-app/commit/b2a1bf8c91514df5eddb8494f5b7d74d21de6bbf) - Agent 操作内置浏览器时，状态条会说明当前在读取、点击还是输入，并在网页上框出目标元素。

- [#717](https://github.com/MoonshotAI/kimi-code-app/pull/717) [`a612502`](https://github.com/MoonshotAI/kimi-code-app/commit/a612502a8208511ecde70bed38b313a5bf6ba2bd) - Agent 操作内置浏览器时，网页四周会亮起缓慢流动的光晕，纯色背景的网页上也能看清。

- [#723](https://github.com/MoonshotAI/kimi-code-app/pull/723) [`7f8b140`](https://github.com/MoonshotAI/kimi-code-app/commit/7f8b140f32e3cfffc9403acc835394c133487bb2) - 修复内置浏览器下载文件时，保存对话框偶尔出现在一个空白灰色窗口上的问题。

- [#716](https://github.com/MoonshotAI/kimi-code-app/pull/716) [`e443be4`](https://github.com/MoonshotAI/kimi-code-app/commit/e443be41eab4d87774ab0394bc9d05c1b862906b) - 浏览器下载记录实时显示下载进度，点击文件名确认后即可打开文件（程序和脚本不会从应用内打开），并可复制下载链接、在文件夹中显示或从列表中移除，文件被删除后会标注"已删除"。

- [#704](https://github.com/MoonshotAI/kimi-code-app/pull/704) [`6a667c1`](https://github.com/MoonshotAI/kimi-code-app/commit/6a667c1324e1666003c59ed67a3df5c0870ede27) - 修复 Agent 操作的浏览器标签不在界面上显示、或应用窗口最小化和隐藏时，页面截图会卡住一分钟、操作前画面缺失的问题。

- [#715](https://github.com/MoonshotAI/kimi-code-app/pull/715) [`499feba`](https://github.com/MoonshotAI/kimi-code-app/commit/499febac44c1a2815e121d5df3270773cec71229) - 修复内置浏览器中按住 Command（Windows / Linux 为 Ctrl）点击或中键点击链接时没有在新标签页打开的问题。

- [#725](https://github.com/MoonshotAI/kimi-code-app/pull/725) [`b98a747`](https://github.com/MoonshotAI/kimi-code-app/commit/b98a74763618da4d5e486eb39e0dbb017d0b565e) - 内置浏览器地址栏新增「在默认浏览器中打开」按钮，可将当前网页用系统默认浏览器打开。

- [#705](https://github.com/MoonshotAI/kimi-code-app/pull/705) [`a01a955`](https://github.com/MoonshotAI/kimi-code-app/commit/a01a95526c6b46b0f55b67c246e86144ca21e951) - 修复点击浏览器操作前画面时，预览从别处飞入、闪一下、又换成对话里另一张截图的问题；图片预览现在从点击的图片放大，关闭时缩回原处。打开图片预览或弹窗时，右侧内置浏览器不再闪白。

- [#745](https://github.com/MoonshotAI/kimi-code-app/pull/745) [`7f4795e`](https://github.com/MoonshotAI/kimi-code-app/commit/7f4795ede0e7a335c9c9855e73dd2a6e3cbf114e) - 修复 Agent 操作内置浏览器时网页画面短暂缩成左上角小框的问题。

- [#714](https://github.com/MoonshotAI/kimi-code-app/pull/714) [`5a03442`](https://github.com/MoonshotAI/kimi-code-app/commit/5a03442202d2a4133c16e96d21fcc0d79313e236) - 修复助手按要求打开网页后浏览器面板仍保持收起、看不到页面的问题。

- [#727](https://github.com/MoonshotAI/kimi-code-app/pull/727) [`7cb9ccd`](https://github.com/MoonshotAI/kimi-code-app/commit/7cb9ccd6d9cadce541ab7580866edc7aebd13f16) - 回答下方的来源按钮直接显示网站图标，不再套圆形外框，没有图标的网站改用灰底地球图标。

- [#732](https://github.com/MoonshotAI/kimi-code-app/pull/732) [`7996a67`](https://github.com/MoonshotAI/kimi-code-app/commit/7996a6708b7637c99d1f20d0bef881603d2a1058) - Canary 内测版的「重新打包 Canary」改为基于 main 分支构建（原先基于 dev 分支）。

- [#749](https://github.com/MoonshotAI/kimi-code-app/pull/749) [`a405523`](https://github.com/MoonshotAI/kimi-code-app/commit/a4055230cc405e414b787b7d3f2ee6ba9a549947) - 修复拖动调整聊天区宽度时消息内容上下跳动的问题。

- [#749](https://github.com/MoonshotAI/kimi-code-app/pull/749) [`a405523`](https://github.com/MoonshotAI/kimi-code-app/commit/a4055230cc405e414b787b7d3f2ee6ba9a549947) - 修复开关后台任务面板时聊天内容和「最新消息」按钮轻微跳动的问题。

- [#699](https://github.com/MoonshotAI/kimi-code-app/pull/699) [`6a36554`](https://github.com/MoonshotAI/kimi-code-app/commit/6a365549702dbbf541a5d77215245223a7054a5e) - 修复输入框上方的后台任务条在宽度充足时也塌缩成图标的问题，现在按实际可用宽度逐个展开或收起，优先保留最近活跃的任务。

- [#727](https://github.com/MoonshotAI/kimi-code-app/pull/727) [`7cb9ccd`](https://github.com/MoonshotAI/kimi-code-app/commit/7cb9ccd6d9cadce541ab7580866edc7aebd13f16) - 修复 GitHub 等纯黑或纯白的网站图标在深色、浅色模式下看不清的问题。

- [#712](https://github.com/MoonshotAI/kimi-code-app/pull/712) [`c7d7ca0`](https://github.com/MoonshotAI/kimi-code-app/commit/c7d7ca0ad4c6cc1b5381939f1e8a4d2f1d1d3206) - 修复登录账号后当前页面被跳转到最近会话的问题。

- [#748](https://github.com/MoonshotAI/kimi-code-app/pull/748) [`2b581fc`](https://github.com/MoonshotAI/kimi-code-app/commit/2b581fc3c4bd9c5575193775ecff78fdf231f8a2) - 修复会话分叉后发送消息不显示、一直显示请求中的问题。

- [#720](https://github.com/MoonshotAI/kimi-code-app/pull/720) [`3cd544b`](https://github.com/MoonshotAI/kimi-code-app/commit/3cd544bee66d718f01796cc35f6e619f2d065b8b) - 修复 Windows 客户端退出全屏后顶部标题栏消失的问题。

- [#728](https://github.com/MoonshotAI/kimi-code-app/pull/728) [`a9dc2c8`](https://github.com/MoonshotAI/kimi-code-app/commit/a9dc2c8c27f28f284d8bbae3e1ac881d630c544e) - 修复在工具输出上滚动、按 End 键或轻碰滚轮后，对话不再自动跟随最新内容的问题。

- [#728](https://github.com/MoonshotAI/kimi-code-app/pull/728) [`a9dc2c8`](https://github.com/MoonshotAI/kimi-code-app/commit/a9dc2c8c27f28f284d8bbae3e1ac881d630c544e) - 修复调整字号后，正在阅读的对话位置发生跳动的问题。

- [#719](https://github.com/MoonshotAI/kimi-code-app/pull/719) [`2b0f62c`](https://github.com/MoonshotAI/kimi-code-app/commit/2b0f62cf35bab913f7d6b5f07b16d6d152f9c341) - 更新安装完成前启动应用时，显示友好的等待界面，安装完成后自动进入，不再误报「无法启动本地服务」。

- [#747](https://github.com/MoonshotAI/kimi-code-app/pull/747) [`9c3ad63`](https://github.com/MoonshotAI/kimi-code-app/commit/9c3ad6368bf7406d8eab1aef2803217b4007f00d) - 修复对话中插入的转向消息仍显示撤销按钮的问题。

- [#728](https://github.com/MoonshotAI/kimi-code-app/pull/728) [`a9dc2c8`](https://github.com/MoonshotAI/kimi-code-app/commit/a9dc2c8c27f28f284d8bbae3e1ac881d630c544e) - 修复对话和右侧面板里稍微向上滚动就冒出「最新消息」「回到底部」按钮的问题。

- [#721](https://github.com/MoonshotAI/kimi-code-app/pull/721) [`715d178`](https://github.com/MoonshotAI/kimi-code-app/commit/715d17838011a6180be5cc03ff5498361c349f51) - 解除对助手访问工作目录之外文件的限制。

- [#698](https://github.com/MoonshotAI/kimi-code-app/pull/698) [`661e172`](https://github.com/MoonshotAI/kimi-code-app/commit/661e172605447bc4fef427cd58a041bef0308174) - 修复右侧面板顶部按钮间距不一致、关闭按钮与面板顶部和右侧边缘距离不等的问题。

- [#743](https://github.com/MoonshotAI/kimi-code-app/pull/743) [`afb380f`](https://github.com/MoonshotAI/kimi-code-app/commit/afb380f6099ea4ed3ba7459a85ac1cc29f07fc99) - 窗口在后台时暂停会话列表和后台任务的计时刷新，减少耗电。

- [#721](https://github.com/MoonshotAI/kimi-code-app/pull/721) [`715d178`](https://github.com/MoonshotAI/kimi-code-app/commit/715d17838011a6180be5cc03ff5498361c349f51) - 自定义模型供应商的 API Key 支持改为引用环境变量。

- [#742](https://github.com/MoonshotAI/kimi-code-app/pull/742) [`200bca9`](https://github.com/MoonshotAI/kimi-code-app/commit/200bca9393b0565a669d82e118456b7d201e282a) - 优化设置页模型供应商配置，支持快速接入 GLM、Minimax 等 Coding Plan

- [#702](https://github.com/MoonshotAI/kimi-code-app/pull/702) [`a4c9f9a`](https://github.com/MoonshotAI/kimi-code-app/commit/a4c9f9abc4daa0b0c13a89664a2e2488c0c5e35e) - 修复对话进行中插入的消息会在会话末尾再留一条的问题。

- [#685](https://github.com/MoonshotAI/kimi-code-app/pull/685) [`94c9eb1`](https://github.com/MoonshotAI/kimi-code-app/commit/94c9eb11e75574ca2e029c440505c51d75a1db5d) - 优化退出应用确认弹窗。

- [#743](https://github.com/MoonshotAI/kimi-code-app/pull/743) [`afb380f`](https://github.com/MoonshotAI/kimi-code-app/commit/afb380f6099ea4ed3ba7459a85ac1cc29f07fc99) - 缩短应用启动后界面首次显示所需的时间。

- [#711](https://github.com/MoonshotAI/kimi-code-app/pull/711) [`8ff472a`](https://github.com/MoonshotAI/kimi-code-app/commit/8ff472a63b372abeee345ad3f8ef6e8bd929a2d9) - 修复终端快捷键。

- [#722](https://github.com/MoonshotAI/kimi-code-app/pull/722) [`3edbe86`](https://github.com/MoonshotAI/kimi-code-app/commit/3edbe86690049c33caa83ca17676d5bb67f1b1dd) - 修复关闭图片预览时偶发的画面跳动。

- [#718](https://github.com/MoonshotAI/kimi-code-app/pull/718) [`2d2502e`](https://github.com/MoonshotAI/kimi-code-app/commit/2d2502e46ac411e079f5e0f9f8bb10e346a1303c) - 修复重复发送同一条带附件的消息时，历史消息里的附件卡片变成一段提示文字的问题。

- [#709](https://github.com/MoonshotAI/kimi-code-app/pull/709) [`d162b79`](https://github.com/MoonshotAI/kimi-code-app/commit/d162b79056dc9e09defd1d51c7315983a1ddc66c) - 修复截图标注在添加到对话、复制、保存或贴图时画面短暂卡顿的问题。

- [#752](https://github.com/MoonshotAI/kimi-code-app/pull/752) [`66558fa`](https://github.com/MoonshotAI/kimi-code-app/commit/66558fa5aaa3c1755570c7bf92d27b68491db853) - Canary 与 Preview 版本不再注册截图快捷键。

- [#743](https://github.com/MoonshotAI/kimi-code-app/pull/743) [`afb380f`](https://github.com/MoonshotAI/kimi-code-app/commit/afb380f6099ea4ed3ba7459a85ac1cc29f07fc99) - 修复搜索会话时匹配到大量工作区导致输入卡顿的问题。

- [#721](https://github.com/MoonshotAI/kimi-code-app/pull/721) [`715d178`](https://github.com/MoonshotAI/kimi-code-app/commit/715d17838011a6180be5cc03ff5498361c349f51) - 修复删除会话时偶尔卡住的问题。

- [#759](https://github.com/MoonshotAI/kimi-code-app/pull/759) [`3f21a65`](https://github.com/MoonshotAI/kimi-code-app/commit/3f21a655bb218a206d3062d8952e6f4f75bd2fb6) - 切换需要加载的会话时显示加载提示，不再长时间空白。

- [#759](https://github.com/MoonshotAI/kimi-code-app/pull/759) [`3f21a65`](https://github.com/MoonshotAI/kimi-code-app/commit/3f21a655bb218a206d3062d8952e6f4f75bd2fb6) - 修复向上滚动过的会话切换再切回时画面闪烁、首次滚动卡顿的问题。

- [#721](https://github.com/MoonshotAI/kimi-code-app/pull/721) [`715d178`](https://github.com/MoonshotAI/kimi-code-app/commit/715d17838011a6180be5cc03ff5498361c349f51) - 加快大型工作区中恢复会话和加载会话列表的速度。

- [#728](https://github.com/MoonshotAI/kimi-code-app/pull/728) [`a9dc2c8`](https://github.com/MoonshotAI/kimi-code-app/commit/a9dc2c8c27f28f284d8bbae3e1ac881d630c544e) - 修复切换会话后立刻滚动时，对话内容短暂空白的问题。

- [#733](https://github.com/MoonshotAI/kimi-code-app/pull/733) [`e2f3da8`](https://github.com/MoonshotAI/kimi-code-app/commit/e2f3da88ece3d335c074e1d1650d39d2a67803be) - 加大设置页选项描述的行距，并在标题与描述之间增加间距。

- [#733](https://github.com/MoonshotAI/kimi-code-app/pull/733) [`e2f3da8`](https://github.com/MoonshotAI/kimi-code-app/commit/e2f3da88ece3d335c074e1d1650d39d2a67803be) - 「数据与隐私」设置项更名「帮助改进 Kimi Code」，说明文案明确不收集代码与对话内容。

- [#729](https://github.com/MoonshotAI/kimi-code-app/pull/729) [`0f3ab08`](https://github.com/MoonshotAI/kimi-code-app/commit/0f3ab08c4b41e5ecdf3569c5e18a987b588c8f1f) - 修复侧边栏的按钮和列表文字容易被误选中的问题。

- [#743](https://github.com/MoonshotAI/kimi-code-app/pull/743) [`afb380f`](https://github.com/MoonshotAI/kimi-code-app/commit/afb380f6099ea4ed3ba7459a85ac1cc29f07fc99) - 减少会话较多时切换会话、出现审批或未读提醒时的侧栏卡顿。

- [#721](https://github.com/MoonshotAI/kimi-code-app/pull/721) [`715d178`](https://github.com/MoonshotAI/kimi-code-app/commit/715d17838011a6180be5cc03ff5498361c349f51) - 修复在回复进行中追加发送的消息，重新打开会话后可能错位、重复或丢失的问题。

- [#728](https://github.com/MoonshotAI/kimi-code-app/pull/728) [`a9dc2c8`](https://github.com/MoonshotAI/kimi-code-app/commit/a9dc2c8c27f28f284d8bbae3e1ac881d630c544e) - 修复回复生成时稍微向上滚动后，对话仍被拖回底部的问题。

- [#734](https://github.com/MoonshotAI/kimi-code-app/pull/734) [`bb603be`](https://github.com/MoonshotAI/kimi-code-app/commit/bb603be4ed0032fe2a86fccfbc2e80051ae7b5b0) - 修复后台子 agent 发起的授权请求不显示授权卡片、会话一直提示待授权的问题。

- [#710](https://github.com/MoonshotAI/kimi-code-app/pull/710) [`26e3654`](https://github.com/MoonshotAI/kimi-code-app/commit/26e36540839b3a2183f399213816a3e0f5468a3d) - 右侧详情面板的 Agent 标签页和「后台 Agent」面板中，悬停被省略截断的名字时显示完整名称。

- [#765](https://github.com/MoonshotAI/kimi-code-app/pull/765) [`0bd66ea`](https://github.com/MoonshotAI/kimi-code-app/commit/0bd66eaf2d3c058fd7d99285b9f897a57ac8a58d) - 修复低分辨率（1x）屏幕上开关滑块贴住右下边缘、不再居中的问题。

- [#722](https://github.com/MoonshotAI/kimi-code-app/pull/722) [`3edbe86`](https://github.com/MoonshotAI/kimi-code-app/commit/3edbe86690049c33caa83ca17676d5bb67f1b1dd) - 修复图片预览里来回切换图片时出现图片加载报错的问题。

- [#764](https://github.com/MoonshotAI/kimi-code-app/pull/764) [`86a7e62`](https://github.com/MoonshotAI/kimi-code-app/commit/86a7e62e0d7a4d94701beb0bbf5686c67943b843) - 加大工具调用列表的行间距。

- [#759](https://github.com/MoonshotAI/kimi-code-app/pull/759) [`3f21a65`](https://github.com/MoonshotAI/kimi-code-app/commit/3f21a655bb218a206d3062d8952e6f4f75bd2fb6) - 文件变更卡片只为最近 3 轮对话展示，更早的轮次不再展示。

- [#721](https://github.com/MoonshotAI/kimi-code-app/pull/721) [`715d178`](https://github.com/MoonshotAI/kimi-code-app/commit/715d17838011a6180be5cc03ff5498361c349f51) - 修复助手偶尔尝试调用不存在的工具并报错的问题。

- [#721](https://github.com/MoonshotAI/kimi-code-app/pull/721) [`715d178`](https://github.com/MoonshotAI/kimi-code-app/commit/715d17838011a6180be5cc03ff5498361c349f51) - 修复项目目录内文件变更过于频繁时界面卡顿的问题。

- [#720](https://github.com/MoonshotAI/kimi-code-app/pull/720) [`3cd544b`](https://github.com/MoonshotAI/kimi-code-app/commit/3cd544bee66d718f01796cc35f6e619f2d065b8b) - Windows 客户端全屏时保留顶部标题栏和菜单。

- [#720](https://github.com/MoonshotAI/kimi-code-app/pull/720) [`3cd544b`](https://github.com/MoonshotAI/kimi-code-app/commit/3cd544bee66d718f01796cc35f6e619f2d065b8b) - 修复 Windows 客户端图片和视频预览的关闭按钮与窗口按钮重叠的问题。

- [#757](https://github.com/MoonshotAI/kimi-code-app/pull/757) [`cd9e1c5`](https://github.com/MoonshotAI/kimi-code-app/commit/cd9e1c5378711368d4330509bb73ff3a2d2e96ec) - 修复 Windows 上编辑器装在自定义目录时，「打开方式」菜单里不显示 VS Code 等应用的问题。

## 1.0.1

### Patch Changes

- [#687](https://github.com/MoonshotAI/kimi-code-app/pull/687) [`b7e2da5`](https://github.com/MoonshotAI/kimi-code-app/commit/b7e2da5f76947442a463e7b397ec09090f607b30) - 修复新会话第一轮里智能体打开内置浏览器时报「需要正在进行的轮次」而失败的问题。

- [#697](https://github.com/MoonshotAI/kimi-code-app/pull/697) [`efbee93`](https://github.com/MoonshotAI/kimi-code-app/commit/efbee93bd796d2639296c0eb11ed3d8f71b466e7) - 浏览器菜单的「模拟页面聚焦」选项更名为「总是保持焦点在页面上」。

- [#675](https://github.com/MoonshotAI/kimi-code-app/pull/675) [`b76d3bc`](https://github.com/MoonshotAI/kimi-code-app/commit/b76d3bc3cebd0a0e62a76768d6cf53ade74aae7e) - 修复 macOS 上内置浏览器中代理按下复制、剪切、粘贴、撤销和重做快捷键没有反应的问题。

- [#697](https://github.com/MoonshotAI/kimi-code-app/pull/697) [`efbee93`](https://github.com/MoonshotAI/kimi-code-app/commit/efbee93bd796d2639296c0eb11ed3d8f71b466e7) - 浏览器菜单宽度随内容自适应，较长的菜单项不再被截断。

- [#688](https://github.com/MoonshotAI/kimi-code-app/pull/688) [`ee69b07`](https://github.com/MoonshotAI/kimi-code-app/commit/ee69b07a037253d20f22ca058aa1b749dbaa34b6) - 浏览器工具调用按动作类型显示不同图标，展开后只列出这一步改变了的页面状态，网址分段显示。

- [#681](https://github.com/MoonshotAI/kimi-code-app/pull/681) [`0989e63`](https://github.com/MoonshotAI/kimi-code-app/commit/0989e633c46aa04041b831bf24025d734e8adea4) - 修复部分模型因浏览器工具参数格式不兼容而无法调用浏览器的问题。

- [#688](https://github.com/MoonshotAI/kimi-code-app/pull/688) [`ee69b07`](https://github.com/MoonshotAI/kimi-code-app/commit/ee69b07a037253d20f22ca058aa1b749dbaa34b6) - 浏览器工具调用的展开详情改为可视化展示，可查看截图并在截图上标出点击、滚动和拖拽位置，原始数据仍可完整查看。

- [#680](https://github.com/MoonshotAI/kimi-code-app/pull/680) [`e4937d8`](https://github.com/MoonshotAI/kimi-code-app/commit/e4937d81ffab45ea59a33c569796a60ab79f8ac6) - 修复 Windows 上编辑和视图菜单中剪切、拷贝、粘贴等条目显示为英文的问题。

- [#673](https://github.com/MoonshotAI/kimi-code-app/pull/673) [`527cf1a`](https://github.com/MoonshotAI/kimi-code-app/commit/527cf1afbde0f9c508e4e48703979520898298ef) - 右侧栏「改动」的 diff 详情页新增「打开文件」按钮，可直接查看文件内容。

- [#682](https://github.com/MoonshotAI/kimi-code-app/pull/682) [`4581f5b`](https://github.com/MoonshotAI/kimi-code-app/commit/4581f5bd2bc15cc52783853b365afb43a46d273d) - 修复 macOS 桌面端图片预览关闭按钮点不中的问题，图片预览支持左右切换会话图片，并新增右键菜单（复制图片、复制路径、另存为、在文件夹中显示、用默认应用打开）。

- [#692](https://github.com/MoonshotAI/kimi-code-app/pull/692) [`8db4e21`](https://github.com/MoonshotAI/kimi-code-app/commit/8db4e21792e9f48a0bef1dbb5a412b5f4580689d) - 修复 macOS 桌面端图片预览关闭按钮点不中的问题。

- [#666](https://github.com/MoonshotAI/kimi-code-app/pull/666) [`f29355c`](https://github.com/MoonshotAI/kimi-code-app/commit/f29355ce89c69cd390847c6065313ef596f9548f) - 链接悬停气泡新增「外部打开」「侧边栏打开」文字按钮，一键打开链接。

- [#697](https://github.com/MoonshotAI/kimi-code-app/pull/697) [`efbee93`](https://github.com/MoonshotAI/kimi-code-app/commit/efbee93bd796d2639296c0eb11ed3d8f71b466e7) - 聊天消息链接悬停气泡的「侧边栏打开」按钮更名为「右侧面板打开」。

- [#665](https://github.com/MoonshotAI/kimi-code-app/pull/665) [`c2ab71d`](https://github.com/MoonshotAI/kimi-code-app/commit/c2ab71d66d4a47c2514d26ca02eb5dd0f9dc4e42) - 悬停聊天消息中的链接时显示完整网址气泡，注册域名加粗，超长网址自动省略截断。

- [#695](https://github.com/MoonshotAI/kimi-code-app/pull/695) [`1088228`](https://github.com/MoonshotAI/kimi-code-app/commit/108822851c9fd5b9f6d50010b22af9d7b05eb51c) - Windows 显示缩放比例较低时，界面边框和分割线不再模糊发虚。

- [#695](https://github.com/MoonshotAI/kimi-code-app/pull/695) [`1088228`](https://github.com/MoonshotAI/kimi-code-app/commit/108822851c9fd5b9f6d50010b22af9d7b05eb51c) - Windows 显示缩放比例较低时，界面文字颜色加深、阅读更清晰。

- [#676](https://github.com/MoonshotAI/kimi-code-app/pull/676) [`e6f35e9`](https://github.com/MoonshotAI/kimi-code-app/commit/e6f35e99536bd644567b1244cff7871b97a97e8a) - 修复内置浏览器里点击邮件、电话等非网页链接会导致页面变空白的问题。

- [#677](https://github.com/MoonshotAI/kimi-code-app/pull/677) [`115f443`](https://github.com/MoonshotAI/kimi-code-app/commit/115f443f6560b5242c55530e64991bcb5f289d7c) - 修复浏览器等待页面条件时，界面响应稍慢就直接报浏览器不可用的问题。

- [#690](https://github.com/MoonshotAI/kimi-code-app/pull/690) [`3b290ef`](https://github.com/MoonshotAI/kimi-code-app/commit/3b290efdb634ac49a2194f1d1dcb7ae108c13585) - 修复打开右侧工作面板时整个界面瞬间左移再弹回的问题。

- [#683](https://github.com/MoonshotAI/kimi-code-app/pull/683) [`deba3a4`](https://github.com/MoonshotAI/kimi-code-app/commit/deba3a4f155b5694235e00af4f1b2650c466fec5) - 截图标注工具栏的操作图标顺序调整为关闭、贴图、保存、复制，复制移到最右侧。

- [#684](https://github.com/MoonshotAI/kimi-code-app/pull/684) [`f418aae`](https://github.com/MoonshotAI/kimi-code-app/commit/f418aae72e5feacac40ca505a4999f3deb3be269) - 统一设置页「供应商」「插件」「快捷键」「浏览器」标签页的样式，与其他标签页保持一致；「浏览器」标签移至「供应商」与「插件」之间。

- [#694](https://github.com/MoonshotAI/kimi-code-app/pull/694) [`6eb12a5`](https://github.com/MoonshotAI/kimi-code-app/commit/6eb12a5264de4d5c24320bf5a092cfce9d56d4e2) - 优化侧边聊天交互。

- [#678](https://github.com/MoonshotAI/kimi-code-app/pull/678) [`7b91414`](https://github.com/MoonshotAI/kimi-code-app/commit/7b91414b6b5d7f76083fdd85cf961ddd2d8486ef) - 修复浏览器里未命中可交互元素的试探点击会让已有元素编号失效的问题。

- [#691](https://github.com/MoonshotAI/kimi-code-app/pull/691) [`de30d3d`](https://github.com/MoonshotAI/kimi-code-app/commit/de30d3de50075f8214d887094406f84ae3d825b7) - 侧边栏新建终端标签页的默认快捷键改为 Control+反引号，切换底部终端面板改为 Control+撇号。

- [#689](https://github.com/MoonshotAI/kimi-code-app/pull/689) [`479c2af`](https://github.com/MoonshotAI/kimi-code-app/commit/479c2afe9a699b1edf593a29c7f13e16da0c4c08) - 修复设置弹窗打开时，保存成功等提示消息被弹窗遮挡的问题。

- [#701](https://github.com/MoonshotAI/kimi-code-app/pull/701) [`a0b8bb6`](https://github.com/MoonshotAI/kimi-code-app/commit/a0b8bb6b74695bc1e862617f90324ad110749a46) - 切换底部终端面板不再默认占用 Control+撇号快捷键，终端统一使用 Control+反引号新建标签页，需要切换快捷键可在设置中自行配置。

- [#679](https://github.com/MoonshotAI/kimi-code-app/pull/679) [`7f5034c`](https://github.com/MoonshotAI/kimi-code-app/commit/7f5034c081bf02f2dea4d8abe9547232b0a84688) - 修复模型请求失败卡片中的报错信息被截断、无法查看完整内容的问题。

## 1.0.0

### Patch Changes

- [#660](https://github.com/MoonshotAI/kimi-code-app/pull/660) [`9810d2d`](https://github.com/MoonshotAI/kimi-code-app/commit/9810d2d9782c605393713cc435faa9a82423af32) - 你的账号，你的生态：kimi.com / kimi.ai 一键登录，套餐用量随时可查；插件市场扩展能力，也可接入自己的模型供应商。

- [#664](https://github.com/MoonshotAI/kimi-code-app/pull/664) [`da6e37a`](https://github.com/MoonshotAI/kimi-code-app/commit/da6e37a84e04fc2f36a682a7ab25a6152ba0d1fa) - 修复内置浏览器新建标签页时地址栏自动聚焦会立即弹出历史记录建议的问题。

- [#660](https://github.com/MoonshotAI/kimi-code-app/pull/660) [`9810d2d`](https://github.com/MoonshotAI/kimi-code-app/commit/9810d2d9782c605393713cc435faa9a82423af32) - 内置浏览器：浏览器进驻右侧面板，标签页随会话常驻，页面信息与 Agent 共享——查文档、看效果、验证页面，无需切到其他窗口。

- [#667](https://github.com/MoonshotAI/kimi-code-app/pull/667) [`9eb9cdb`](https://github.com/MoonshotAI/kimi-code-app/commit/9eb9cdb9618311b7b78bf2ca9eee20957982329f) - 修复切换会话时整个窗口短暂出现画面错乱的问题。

- [#660](https://github.com/MoonshotAI/kimi-code-app/pull/660) [`9810d2d`](https://github.com/MoonshotAI/kimi-code-app/commit/9810d2d9782c605393713cc435faa9a82423af32) - 不用离开窗口：内置终端、代码差异查看、文件预览与 Markdown 渲染都在应用内，聊天里提到的任何文件路径都可以直接点开。

- [#671](https://github.com/MoonshotAI/kimi-code-app/pull/671) [`fade162`](https://github.com/MoonshotAI/kimi-code-app/commit/fade162be2bcdfaf98bc6793b40bfbb29e37495f) - 修复 Windows 下从会话顶部或文件预览打开文件夹时错误跳转到桌面的问题。

- [#660](https://github.com/MoonshotAI/kimi-code-app/pull/660) [`9810d2d`](https://github.com/MoonshotAI/kimi-code-app/commit/9810d2d9782c605393713cc435faa9a82423af32) - 管理你的所有项目：多工作区、多会话并行，标签页、置顶、批量管理、AI 自动命名、全局搜索，再多项目也不乱。

- [#662](https://github.com/MoonshotAI/kimi-code-app/pull/662) [`03cb6d4`](https://github.com/MoonshotAI/kimi-code-app/commit/03cb6d469d44a9640611ce367f10651c8717d9c8) - 修复右侧面板新建菜单与空态启动器中面板快捷键显示不一致、排列顺序不同的问题。

- [#660](https://github.com/MoonshotAI/kimi-code-app/pull/660) [`9810d2d`](https://github.com/MoonshotAI/kimi-code-app/commit/9810d2d9782c605393713cc435faa9a82423af32) - 从对话到交付的完整工作流：先出计划再动手，计划可评审、可反馈；长任务可转后台继续运行、随时接管；tower 多智能体协作模式（实验）让多个 Agent 并行推进。

- [#660](https://github.com/MoonshotAI/kimi-code-app/pull/660) [`9810d2d`](https://github.com/MoonshotAI/kimi-code-app/commit/9810d2d9782c605393713cc435faa9a82423af32) - 指哪改哪：截图标注、划词评论、@ 提及文件、直接把文件夹拖进输入框；网页上也能点选元素、框选区域，写句评论发给 Agent。

- [#656](https://github.com/MoonshotAI/kimi-code-app/pull/656) [`fb0795d`](https://github.com/MoonshotAI/kimi-code-app/commit/fb0795dec9b6571a6f93f747994a60ba7ddbfba0) - 修复会话输出时界面和输入明显卡顿、审批卡片弹出时输入框闪烁的问题。

- [#607](https://github.com/MoonshotAI/kimi-code-app/pull/607) [`177fcfc`](https://github.com/MoonshotAI/kimi-code-app/commit/177fcfca3e011d9b0f241aedd3765e085da850b9) - 修复会话标题菜单复制反馈闪烁的问题，并按用途整理菜单分组。

- [#663](https://github.com/MoonshotAI/kimi-code-app/pull/663) [`6b06423`](https://github.com/MoonshotAI/kimi-code-app/commit/6b06423dff866fa9d54a9f464b5d254367cb0384) - 修复窗口大小变化后按钮悬停提示文字被挤压换行、需要多次悬停才恢复正常的问题。

- [#660](https://github.com/MoonshotAI/kimi-code-app/pull/660) [`9810d2d`](https://github.com/MoonshotAI/kimi-code-app/commit/9810d2d9782c605393713cc435faa9a82423af32) - 看得见的 AI 编程：Agent 的每一步都清晰可见——工具调用、思考过程、每轮修改了哪些文件；敏感操作会弹出审批提示，三档权限模式（始终询问 / 必要时询问 / 完全自动）由你掌控。

## 1.0.0-beta.1

### Patch Changes

- [#651](https://github.com/MoonshotAI/kimi-code-app/pull/651) [`2044b9f`](https://github.com/MoonshotAI/kimi-code-app/commit/2044b9fd1823c4b55971eb331edb6d0292cf7fb9) - Agent 工具卡片运行时的进度点阵改为圆形加载动画。

- [#651](https://github.com/MoonshotAI/kimi-code-app/pull/651) [`2044b9f`](https://github.com/MoonshotAI/kimi-code-app/commit/2044b9fd1823c4b55971eb331edb6d0292cf7fb9) - Agent 工具卡片展开后不再显示任务 ID、续跑提示等内部字段，只保留结果摘要或错误信息。

- [#651](https://github.com/MoonshotAI/kimi-code-app/pull/651) [`2044b9f`](https://github.com/MoonshotAI/kimi-code-app/commit/2044b9fd1823c4b55971eb331edb6d0292cf7fb9) - 修复写入和编辑文件的授权卡片中文件路径与代码预览紧贴在一起的问题。

- [#646](https://github.com/MoonshotAI/kimi-code-app/pull/646) [`c061002`](https://github.com/MoonshotAI/kimi-code-app/commit/c061002604a2f4cb032829a575c517f0026ce448) - 修复 Beta 发布后固定下载链接仍提供旧版安装包的问题。

- [#581](https://github.com/MoonshotAI/kimi-code-app/pull/581) [`a8bf96c`](https://github.com/MoonshotAI/kimi-code-app/commit/a8bf96c8ee7d0be9a9108aef047a8b0c8b41eea5) - 修复 macOS 按 Command W 时关闭窗口而非当前右侧面板标签的问题。

- [#581](https://github.com/MoonshotAI/kimi-code-app/pull/581) [`a8bf96c`](https://github.com/MoonshotAI/kimi-code-app/commit/a8bf96c8ee7d0be9a9108aef047a8b0c8b41eea5) - 桌面端新增应用内浏览器，可在对话旁浏览网页、验证本地应用、标注页面，并让 Agent 操作网页完成任务。

  - **在对话旁浏览网页**

    - 从右侧面板的「+」菜单打开浏览器，支持同时打开多个网页，在地址栏输入网址、本地开发地址或搜索内容，并通过历史记录补全快速返回访问过的页面。
    - 空白标签页展示 Agent 可代为完成的浏览操作，方便快速上手；浏览器标签支持展开和恢复面板大小。
    - 支持前进、后退、刷新、页内查找、缩放、截图和打印，也可在外部浏览器中打开当前网页。
    - 标签页支持复制、重命名、静音，以及关闭其他标签或右侧标签；切换对话后保留各自的标签，重启应用后恢复标签与网址，分叉会话时一并复制浏览器标签。
    - 支持使用常见的浏览器快捷键操作，例如 Command/Control + T 新建标签、Command/Control + L 聚焦地址栏、Command/Control + R 刷新网页。

  - **把网页标注带入对话**

    - 选取网页元素或框选页面区域，添加评论后直接引用到消息输入框，方便指出需要修改的界面、说明问题或提供页面上下文。
    - 元素标注可查看标签、ID、类名、尺寸等属性，支持复制类名或插入评论，并可选择附带截图；区域标注附带截图。
    - 引用保留网页来源、选取位置和捕获时间，可在发送前查看详情，也可在历史消息中回看。

  - **预览不同设备上的页面**

    - 提供手机、平板和桌面尺寸预设，支持横竖屏旋转；响应式模式可输入宽高，也可拖动页面边缘调整尺寸。
    - 支持适应可用空间或按固定比例显示，并可设置预览区域的背景颜色，方便检查不同尺寸下的布局。
    - 提供「模拟页面聚焦」选项，方便检查失焦后会隐藏的菜单等页面内容。

  - **让 Agent 操作浏览器**

    - Agent 可在当前会话中打开和导航网页、读取页面元素与截图，执行点击、输入、选择、滚动和拖拽，也可切换设备预设或调整响应式尺寸。
    - Agent 可按视口、文档或元素范围分页读取网页文字，筛选和分页读取页面元素，查看截图的局部高清细节，并等待元素、文字或网址满足指定条件。
    - 支持在后台标签中执行任务；标签栏显示控制状态，页面提供操作指针与点击反馈，用户可手动接管。
    - 对话中的操作记录展示具体动作、目标和输入内容，需要审批时可查看操作说明与参数。
    - Agent 可查询浏览历史和下载记录，查看下载状态与文件保存位置。

  - **管理浏览偏好与网站数据**
    - 设置中提供浏览器偏好、历史记录、下载和网站设置，可选择默认搜索引擎、默认缩放及下载保存方式，按日期浏览或搜索历史与下载记录。
    - 支持管理网站的位置、摄像头、麦克风、通知等权限；权限请求在浏览器区域内处理，对应标签和侧边栏提示待处理请求；被系统拒绝的摄像头和麦克风权限会单独标出，并提供直达系统设置的入口。
    - 支持清理浏览数据，并管理网站的权限与存储。

- [#651](https://github.com/MoonshotAI/kimi-code-app/pull/651) [`2044b9f`](https://github.com/MoonshotAI/kimi-code-app/commit/2044b9fd1823c4b55971eb331edb6d0292cf7fb9) - 修复展开工作面板时，面板与下方工作胶囊之间的间距比胶囊与输入框之间更宽的问题。

- [#651](https://github.com/MoonshotAI/kimi-code-app/pull/651) [`2044b9f`](https://github.com/MoonshotAI/kimi-code-app/commit/2044b9fd1823c4b55971eb331edb6d0292cf7fb9) - 模型选择按钮、子代理模型信息和辅助模型选择器中的思考程度统一为首字母大写。

- [`df546fb`](https://github.com/MoonshotAI/kimi-code-app/commit/df546fbf525a89ab6ac1ccee3fb50152db3c71ca) - 修复空会话时右上角终端和面板按钮图标比会话内小一号的问题。

- [#581](https://github.com/MoonshotAI/kimi-code-app/pull/581) [`a8bf96c`](https://github.com/MoonshotAI/kimi-code-app/commit/a8bf96c8ee7d0be9a9108aef047a8b0c8b41eea5) - 修复键盘聚焦图标按钮时不显示提示的问题。

- [#649](https://github.com/MoonshotAI/kimi-code-app/pull/649) [`b86174c`](https://github.com/MoonshotAI/kimi-code-app/commit/b86174c7384716a015488f100f929bbae79e58f3) - 模型选择器和设置中的 Kimi 订阅供应商显示为“Kimi 订阅”，不再显示内部标识 managed:kimi-code。

- [#581](https://github.com/MoonshotAI/kimi-code-app/pull/581) [`a8bf96c`](https://github.com/MoonshotAI/kimi-code-app/commit/a8bf96c8ee7d0be9a9108aef047a8b0c8b41eea5) - 修复菜单顶部无法操作、二次点击按钮重新打开及点击拖拽区域无法关闭的问题。

- [#581](https://github.com/MoonshotAI/kimi-code-app/pull/581) [`a8bf96c`](https://github.com/MoonshotAI/kimi-code-app/commit/a8bf96c8ee7d0be9a9108aef047a8b0c8b41eea5) - 加号菜单显示浏览器和终端快捷键，并支持 Control+撇号新建侧边栏终端。

- [#581](https://github.com/MoonshotAI/kimi-code-app/pull/581) [`a8bf96c`](https://github.com/MoonshotAI/kimi-code-app/commit/a8bf96c8ee7d0be9a9108aef047a8b0c8b41eea5) - 修复切换会话后迟到的菜单操作可能作用于错误会话的问题。

- [#651](https://github.com/MoonshotAI/kimi-code-app/pull/651) [`2044b9f`](https://github.com/MoonshotAI/kimi-code-app/commit/2044b9fd1823c4b55971eb331edb6d0292cf7fb9) - 夹在两段正文之间的单个工具调用，上下间距与步骤组保持一致。

- [#651](https://github.com/MoonshotAI/kimi-code-app/pull/651) [`2044b9f`](https://github.com/MoonshotAI/kimi-code-app/commit/2044b9fd1823c4b55971eb331edb6d0292cf7fb9) - 等待回复时的吉祥物旁重新显示“请求中…”或“思考中…”提示。

- [`2205d25`](https://github.com/MoonshotAI/kimi-code-app/commit/2205d254f9739dd44bcef3935e674a4229ff7fb0) - 空会话页的工作区选择器向右移动了 16px，与输入框对齐更协调。

## 1.0.0-beta.0

### Major Changes

- [#627](https://github.com/MoonshotAI/kimi-code-app/pull/627) [`fab7b9b`](https://github.com/MoonshotAI/kimi-code-app/commit/fab7b9b37b5829e481e45ad800f80c6b766f34a4) - 桌面端版本升级至 1.0.0-beta.0，进入 Beta 测试阶段并在主界面标注 Beta。

### Patch Changes

- [#627](https://github.com/MoonshotAI/kimi-code-app/pull/627) [`fab7b9b`](https://github.com/MoonshotAI/kimi-code-app/commit/fab7b9b37b5829e481e45ad800f80c6b766f34a4) - 精简设置「关于」的版本区：应用版本只显示版本号，移除服务器地址行，服务端版本改为内置服务的代码版本。

- [#620](https://github.com/MoonshotAI/kimi-code-app/pull/620) [`e8eb822`](https://github.com/MoonshotAI/kimi-code-app/commit/e8eb8229c5912a1575f11fb93b170f73a6082d59) - 折叠摘要中的失败数量改为与所在摘要相同的样式显示，不再标红。

- [#620](https://github.com/MoonshotAI/kimi-code-app/pull/620) [`e8eb822`](https://github.com/MoonshotAI/kimi-code-app/commit/e8eb8229c5912a1575f11fb93b170f73a6082d59) - 审批卡片改用 Enter 批准、Esc 拒绝、⌘/Ctrl+Enter 本会话内批准，数字键仍可使用。

- [#627](https://github.com/MoonshotAI/kimi-code-app/pull/627) [`fab7b9b`](https://github.com/MoonshotAI/kimi-code-app/commit/fab7b9b37b5829e481e45ad800f80c6b766f34a4) - Beta 版本与正式版共用同一更新通道，Beta 用户在正式版发布后会自动升级，无需手动重装。

- [#645](https://github.com/MoonshotAI/kimi-code-app/pull/645) [`08831c3`](https://github.com/MoonshotAI/kimi-code-app/commit/08831c35d40b3da3fc66cecea0c1b77155311860) - 修复历史会话中中断回复后重新发送的消息没有生成新一轮回复的问题。

- [#641](https://github.com/MoonshotAI/kimi-code-app/pull/641) [`fbb5789`](https://github.com/MoonshotAI/kimi-code-app/commit/fbb5789afaf74d2755dd18143624ba703c69a16e) - 按新设计调整输入框上方的状态标签与目标、计划面板的样式。

- [#545](https://github.com/MoonshotAI/kimi-code-app/pull/545) [`1578b77`](https://github.com/MoonshotAI/kimi-code-app/commit/1578b77dbd38e844d925c9ab94b66b8e0ba1ec64) - 关闭仍有程序运行的终端时显示确认，批量关闭时集中列出受影响的标签页和进程。

- [#545](https://github.com/MoonshotAI/kimi-code-app/pull/545) [`1578b77`](https://github.com/MoonshotAI/kimi-code-app/commit/1578b77dbd38e844d925c9ab94b66b8e0ba1ec64) - 支持使用 Control+Tab 和 Control+Shift+Tab 循环切换面板标签页。

- [#618](https://github.com/MoonshotAI/kimi-code-app/pull/618) [`0efdf1a`](https://github.com/MoonshotAI/kimi-code-app/commit/0efdf1a921a57e4851048168cf9a58d32d5d559a) - 支持在输入框内两秒内连按两次 Esc 中断运行中的会话，首次按下时停止按钮显示 ESC 提示，并取消 Esc 自动撤回回填。

- [#614](https://github.com/MoonshotAI/kimi-code-app/pull/614) [`f50d5eb`](https://github.com/MoonshotAI/kimi-code-app/commit/f50d5ebce0b6947055de5fbcd5f336da01e2b54b) - 修复打开「关于」窗口时按 ⌘W 弹出主进程错误的问题。

- [#622](https://github.com/MoonshotAI/kimi-code-app/pull/622) [`3bd9b2c`](https://github.com/MoonshotAI/kimi-code-app/commit/3bd9b2c784191d4dcb5eddf1cc8bbcf2e3775912) - 修复撤销引导消息后聊天内容丢失或重新出现的问题。

- [#620](https://github.com/MoonshotAI/kimi-code-app/pull/620) [`e8eb822`](https://github.com/MoonshotAI/kimi-code-app/commit/e8eb8229c5912a1575f11fb93b170f73a6082d59) - 展开或收起工作过程、最小化提问卡片时增加过渡动画。

- [#632](https://github.com/MoonshotAI/kimi-code-app/pull/632) [`f47f08e`](https://github.com/MoonshotAI/kimi-code-app/commit/f47f08ea17ca405a1449e64f996f41bbf81d99e4) - 修复斜杠菜单误显示终端专属技能 /custom-theme 的问题。

- [#620](https://github.com/MoonshotAI/kimi-code-app/pull/620) [`e8eb822`](https://github.com/MoonshotAI/kimi-code-app/commit/e8eb8229c5912a1575f11fb93b170f73a6082d59) - 修复浅色模式下代码差异行背景过深、增删符号看不清的问题。

- [#606](https://github.com/MoonshotAI/kimi-code-app/pull/606) [`4e62de4`](https://github.com/MoonshotAI/kimi-code-app/commit/4e62de4a1bded1c8884565b1738400a7282dfb72) - 修复图片说明遮罩误显示、表格边缘错色及代码排版受正文样式影响的问题。

- [#606](https://github.com/MoonshotAI/kimi-code-app/pull/606) [`4e62de4`](https://github.com/MoonshotAI/kimi-code-app/commit/4e62de4a1bded1c8884565b1738400a7282dfb72) - 统一 Markdown 的标题、列表、表格和代码块样式，支持 Markdown 代码块切换预览，并为代码滚动区域增加转角平滑过渡的渐隐边缘与不透明行号栏。

- [#606](https://github.com/MoonshotAI/kimi-code-app/pull/606) [`4e62de4`](https://github.com/MoonshotAI/kimi-code-app/commit/4e62de4a1bded1c8884565b1738400a7282dfb72) - 恢复 Markdown 对字号设置的响应，并提高浅色数字和深色关键词的可读性。

- [#606](https://github.com/MoonshotAI/kimi-code-app/pull/606) [`4e62de4`](https://github.com/MoonshotAI/kimi-code-app/commit/4e62de4a1bded1c8884565b1738400a7282dfb72) - 图片加载失败的占位提示不再被选中。

- [#606](https://github.com/MoonshotAI/kimi-code-app/pull/606) [`4e62de4`](https://github.com/MoonshotAI/kimi-code-app/commit/4e62de4a1bded1c8884565b1738400a7282dfb72) - 修复连续行内代码之间的中文标点被换到行首的问题。

- [#606](https://github.com/MoonshotAI/kimi-code-app/pull/606) [`4e62de4`](https://github.com/MoonshotAI/kimi-code-app/commit/4e62de4a1bded1c8884565b1738400a7282dfb72) - 恢复代码块标题栏语言名前的图标。

- [#606](https://github.com/MoonshotAI/kimi-code-app/pull/606) [`4e62de4`](https://github.com/MoonshotAI/kimi-code-app/commit/4e62de4a1bded1c8884565b1738400a7282dfb72) - 修复 Markdown 链接悬停时下划线位置跳动的问题。

- [#606](https://github.com/MoonshotAI/kimi-code-app/pull/606) [`4e62de4`](https://github.com/MoonshotAI/kimi-code-app/commit/4e62de4a1bded1c8884565b1738400a7282dfb72) - 修复有序列表的两位数及更长编号被裁切的问题。

- [#606](https://github.com/MoonshotAI/kimi-code-app/pull/606) [`4e62de4`](https://github.com/MoonshotAI/kimi-code-app/commit/4e62de4a1bded1c8884565b1738400a7282dfb72) - 修复 Markdown 预览的状态恢复、部分围栏识别及嵌套代码复制问题。

- [#606](https://github.com/MoonshotAI/kimi-code-app/pull/606) [`4e62de4`](https://github.com/MoonshotAI/kimi-code-app/commit/4e62de4a1bded1c8884565b1738400a7282dfb72) - 修复宽表格滚动条错位及长 diff、纯文本代码块未限制高度的问题。

- [#606](https://github.com/MoonshotAI/kimi-code-app/pull/606) [`4e62de4`](https://github.com/MoonshotAI/kimi-code-app/commit/4e62de4a1bded1c8884565b1738400a7282dfb72) - 补齐 Markdown 代码块中标题、强调、链接等语法的高亮颜色。

- [#606](https://github.com/MoonshotAI/kimi-code-app/pull/606) [`4e62de4`](https://github.com/MoonshotAI/kimi-code-app/commit/4e62de4a1bded1c8884565b1738400a7282dfb72) - Markdown 表格使用与代码块一致的滚动条样式。

- [#606](https://github.com/MoonshotAI/kimi-code-app/pull/606) [`4e62de4`](https://github.com/MoonshotAI/kimi-code-app/commit/4e62de4a1bded1c8884565b1738400a7282dfb72) - 修复会话中英文自动间距未生效及表格链接前缺少间距的问题。

- [#606](https://github.com/MoonshotAI/kimi-code-app/pull/606) [`4e62de4`](https://github.com/MoonshotAI/kimi-code-app/commit/4e62de4a1bded1c8884565b1738400a7282dfb72) - 移除任务列表勾选框后多余的正文空格。

- [#606](https://github.com/MoonshotAI/kimi-code-app/pull/606) [`4e62de4`](https://github.com/MoonshotAI/kimi-code-app/commit/4e62de4a1bded1c8884565b1738400a7282dfb72) - Mermaid 提示气泡在附近按钮间平滑移动，远距离切换时改为淡入淡出。

- [#601](https://github.com/MoonshotAI/kimi-code-app/pull/601) [`b3620e0`](https://github.com/MoonshotAI/kimi-code-app/commit/b3620e0f28ec663c8f4ea5a23db1f92d0e022261) - 修复打开 HTML 预览后，点击预览区域无法收起「打开方式」下拉菜单的问题。

- [#620](https://github.com/MoonshotAI/kimi-code-app/pull/620) [`e8eb822`](https://github.com/MoonshotAI/kimi-code-app/commit/e8eb8229c5912a1575f11fb93b170f73a6082d59) - 用户消息操作栏、回复底部的时间与复制按钮以及等待中的加载标识改为新样式。

- [#604](https://github.com/MoonshotAI/kimi-code-app/pull/604) [`d196201`](https://github.com/MoonshotAI/kimi-code-app/commit/d1962011d93365433d10cb527b5ebb9353b1506d) - 优化消息流加载性能

- [#601](https://github.com/MoonshotAI/kimi-code-app/pull/601) [`b3620e0`](https://github.com/MoonshotAI/kimi-code-app/commit/b3620e0f28ec663c8f4ea5a23db1f92d0e022261) - 修复打开 HTML、PDF 等文件时，默认打开方式没有优先选中浏览器等推荐应用的问题。

- [#545](https://github.com/MoonshotAI/kimi-code-app/pull/545) [`1578b77`](https://github.com/MoonshotAI/kimi-code-app/commit/1578b77dbd38e844d925c9ab94b66b8e0ba1ec64) - 修复切换会话后后台终端丢失最新输出的问题。

- [#545](https://github.com/MoonshotAI/kimi-code-app/pull/545) [`1578b77`](https://github.com/MoonshotAI/kimi-code-app/commit/1578b77dbd38e844d925c9ab94b66b8e0ba1ec64) - 面板标签页右键菜单的关闭操作添加统一图标。

- [#545](https://github.com/MoonshotAI/kimi-code-app/pull/545) [`1578b77`](https://github.com/MoonshotAI/kimi-code-app/commit/1578b77dbd38e844d925c9ab94b66b8e0ba1ec64) - 修复标签页右键菜单文字会被选中的问题。

- [#545](https://github.com/MoonshotAI/kimi-code-app/pull/545) [`1578b77`](https://github.com/MoonshotAI/kimi-code-app/commit/1578b77dbd38e844d925c9ab94b66b8e0ba1ec64) - 修复页面缩放后标签页菜单位置偏移的问题。

- [#545](https://github.com/MoonshotAI/kimi-code-app/pull/545) [`1578b77`](https://github.com/MoonshotAI/kimi-code-app/commit/1578b77dbd38e844d925c9ab94b66b8e0ba1ec64) - 修复会话增多后标签页状态无法保存的问题。

- [#545](https://github.com/MoonshotAI/kimi-code-app/pull/545) [`1578b77`](https://github.com/MoonshotAI/kimi-code-app/commit/1578b77dbd38e844d925c9ab94b66b8e0ba1ec64) - 支持右键关闭面板标签页、其他标签页或右侧标签页。

- [#545](https://github.com/MoonshotAI/kimi-code-app/pull/545) [`1578b77`](https://github.com/MoonshotAI/kimi-code-app/commit/1578b77dbd38e844d925c9ab94b66b8e0ba1ec64) - 刷新、重启和切换对话后恢复之前打开的面板标签页、顺序和选中状态。

- [#620](https://github.com/MoonshotAI/kimi-code-app/pull/620) [`e8eb822`](https://github.com/MoonshotAI/kimi-code-app/commit/e8eb8229c5912a1575f11fb93b170f73a6082d59) - 提问卡片和审批卡片改为新样式，按钮上直接显示对应快捷键。

- [#615](https://github.com/MoonshotAI/kimi-code-app/pull/615) [`95f443d`](https://github.com/MoonshotAI/kimi-code-app/commit/95f443de00bafb0019a4a29973764e8937b5fc81) - 修复开发环境下终端关闭后退出应用时弹出"主进程发生 JavaScript 错误"的问题。

- [#602](https://github.com/MoonshotAI/kimi-code-app/pull/602) [`a4a342a`](https://github.com/MoonshotAI/kimi-code-app/commit/a4a342a552c36b3e38a30d2a970953c1cae2537e) - 新增完整截图工具，支持窗口吸附、图片标注、评论、复制、保存和贴图。

- [#599](https://github.com/MoonshotAI/kimi-code-app/pull/599) [`00fd2c6`](https://github.com/MoonshotAI/kimi-code-app/commit/00fd2c6a178d13a457de3447b4f8a156c9a77092) - 退出应用时，如果本机有正在进行的会话，会先弹出确认提示，避免误退出中断会话。

- [#545](https://github.com/MoonshotAI/kimi-code-app/pull/545) [`1578b77`](https://github.com/MoonshotAI/kimi-code-app/commit/1578b77dbd38e844d925c9ab94b66b8e0ba1ec64) - 支持拖动面板标签页调整顺序，也可使用 Alt 加左右方向键排序。

- [#602](https://github.com/MoonshotAI/kimi-code-app/pull/602) [`a4a342a`](https://github.com/MoonshotAI/kimi-code-app/commit/a4a342a552c36b3e38a30d2a970953c1cae2537e) - 修复取消退出应用后截图被中断及后续启动变慢的问题。

- [#602](https://github.com/MoonshotAI/kimi-code-app/pull/602) [`a4a342a`](https://github.com/MoonshotAI/kimi-code-app/commit/a4a342a552c36b3e38a30d2a970953c1cae2537e) - 截图后可直接输入评论，并与图片作为同一条标注添加到对话。

- [#602](https://github.com/MoonshotAI/kimi-code-app/pull/602) [`a4a342a`](https://github.com/MoonshotAI/kimi-code-app/commit/a4a342a552c36b3e38a30d2a970953c1cae2537e) - 修复在正文中间插入截图评论时与后文粘连的问题。

- [#602](https://github.com/MoonshotAI/kimi-code-app/pull/602) [`a4a342a`](https://github.com/MoonshotAI/kimi-code-app/commit/a4a342a552c36b3e38a30d2a970953c1cae2537e) - 修复 macOS 主窗口隐藏时通过全局快捷键截图后贴图不可见的问题。

- [#602](https://github.com/MoonshotAI/kimi-code-app/pull/602) [`a4a342a`](https://github.com/MoonshotAI/kimi-code-app/commit/a4a342a552c36b3e38a30d2a970953c1cae2537e) - 修复 Linux 关闭主窗口后因截图浮层残留而无法退出的问题。

- [#602](https://github.com/MoonshotAI/kimi-code-app/pull/602) [`a4a342a`](https://github.com/MoonshotAI/kimi-code-app/commit/a4a342a552c36b3e38a30d2a970953c1cae2537e) - 修复 macOS 进入和退出截图时闪出空白画面的问题。

- [#602](https://github.com/MoonshotAI/kimi-code-app/pull/602) [`a4a342a`](https://github.com/MoonshotAI/kimi-code-app/commit/a4a342a552c36b3e38a30d2a970953c1cae2537e) - 修复较旧 macOS 上无法加载截图组件的问题。

- [#602](https://github.com/MoonshotAI/kimi-code-app/pull/602) [`a4a342a`](https://github.com/MoonshotAI/kimi-code-app/commit/a4a342a552c36b3e38a30d2a970953c1cae2537e) - 修复添加菜单中截屏入口的悬停背景未覆盖整行的问题。

- [#602](https://github.com/MoonshotAI/kimi-code-app/pull/602) [`a4a342a`](https://github.com/MoonshotAI/kimi-code-app/commit/a4a342a552c36b3e38a30d2a970953c1cae2537e) - 截图评论支持多行输入，并随内容自动调整高度。

- [#602](https://github.com/MoonshotAI/kimi-code-app/pull/602) [`a4a342a`](https://github.com/MoonshotAI/kimi-code-app/commit/a4a342a552c36b3e38a30d2a970953c1cae2537e) - 修复小尺寸贴图和缩放时图片变形的问题。

- [#602](https://github.com/MoonshotAI/kimi-code-app/pull/602) [`a4a342a`](https://github.com/MoonshotAI/kimi-code-app/commit/a4a342a552c36b3e38a30d2a970953c1cae2537e) - 补齐贴图的中文无障碍描述。

- [#602](https://github.com/MoonshotAI/kimi-code-app/pull/602) [`a4a342a`](https://github.com/MoonshotAI/kimi-code-app/commit/a4a342a552c36b3e38a30d2a970953c1cae2537e) - 禁止预览窗口发起或取消主应用的截图。

- [#602](https://github.com/MoonshotAI/kimi-code-app/pull/602) [`a4a342a`](https://github.com/MoonshotAI/kimi-code-app/commit/a4a342a552c36b3e38a30d2a970953c1cae2537e) - 修复截图资源协议重复注册带来的启动兼容性问题。

- [#602](https://github.com/MoonshotAI/kimi-code-app/pull/602) [`a4a342a`](https://github.com/MoonshotAI/kimi-code-app/commit/a4a342a552c36b3e38a30d2a970953c1cae2537e) - 移除截图预选阶段底部的全屏按钮浮条。

- [#602](https://github.com/MoonshotAI/kimi-code-app/pull/602) [`a4a342a`](https://github.com/MoonshotAI/kimi-code-app/commit/a4a342a552c36b3e38a30d2a970953c1cae2537e) - 在输入框的截屏菜单项旁显示快捷键及占用提示，点击可直达对应设置。

- [#602](https://github.com/MoonshotAI/kimi-code-app/pull/602) [`a4a342a`](https://github.com/MoonshotAI/kimi-code-app/commit/a4a342a552c36b3e38a30d2a970953c1cae2537e) - 修复截屏快捷键按钮悬停时叠加两层灰色背景的问题。

- [#602](https://github.com/MoonshotAI/kimi-code-app/pull/602) [`a4a342a`](https://github.com/MoonshotAI/kimi-code-app/commit/a4a342a552c36b3e38a30d2a970953c1cae2537e) - 修复修改截图快捷键时无法正确回退被占用组合的问题。

- [#638](https://github.com/MoonshotAI/kimi-code-app/pull/638) [`5bb2b3f`](https://github.com/MoonshotAI/kimi-code-app/commit/5bb2b3f63c6e631d2d9e9eac250574352f21bb9e) - 切换会话时提前发出会话内容请求，缩短切换后的空白时间。

- [#591](https://github.com/MoonshotAI/kimi-code-app/pull/591) [`3068da2`](https://github.com/MoonshotAI/kimi-code-app/commit/3068da2d001dbb5040b610d2122d1e9b14b0e95f) - 侧边聊天更换新空态，输入框与主输入框统一样式并支持上传文件。

- [#625](https://github.com/MoonshotAI/kimi-code-app/pull/625) [`7976e00`](https://github.com/MoonshotAI/kimi-code-app/commit/7976e00c562bc5b4f837e3f1dd73e9ae3525214c) - 修复刷新页面后侧边栏宽度闪动的问题。

- [#591](https://github.com/MoonshotAI/kimi-code-app/pull/591) [`3068da2`](https://github.com/MoonshotAI/kimi-code-app/commit/3068da2d001dbb5040b610d2122d1e9b14b0e95f) - 调整侧边栏：视图菜单按钮和「按工作区分组」更换新图标，会话右键菜单重新分组并去掉底部时间、删除项悬停背景不再标红，底部设置按钮与列表操作按钮对齐。

- [#645](https://github.com/MoonshotAI/kimi-code-app/pull/645) [`08831c3`](https://github.com/MoonshotAI/kimi-code-app/commit/08831c35d40b3da3fc66cecea0c1b77155311860) - 修复终端专属的主题设置技能出现在桌面端技能列表中的问题。

- [#545](https://github.com/MoonshotAI/kimi-code-app/pull/545) [`1578b77`](https://github.com/MoonshotAI/kimi-code-app/commit/1578b77dbd38e844d925c9ab94b66b8e0ba1ec64) - 右侧面板增加滑入和滑出动画。

- [#545](https://github.com/MoonshotAI/kimi-code-app/pull/545) [`1578b77`](https://github.com/MoonshotAI/kimi-code-app/commit/1578b77dbd38e844d925c9ab94b66b8e0ba1ec64) - 修复标签页拖动排序不流畅及长标签栏难以拖到可视区域之外的问题。

- [#598](https://github.com/MoonshotAI/kimi-code-app/pull/598) [`688284f`](https://github.com/MoonshotAI/kimi-code-app/commit/688284ffccedeeb6b3f5a48638eb876974bb9d64) - 右侧面板开合按钮在展开和收起时保持原位。

- [#602](https://github.com/MoonshotAI/kimi-code-app/pull/602) [`a4a342a`](https://github.com/MoonshotAI/kimi-code-app/commit/a4a342a552c36b3e38a30d2a970953c1cae2537e) - 修复三击选中文字时评论气泡消失的问题。

- [#610](https://github.com/MoonshotAI/kimi-code-app/pull/610) [`79aa374`](https://github.com/MoonshotAI/kimi-code-app/commit/79aa374a8c8e7349f113276f4cfc17879019f37c) - 支持在对话运行中使用 ⌘+Enter 直接发送引导消息。

- [#621](https://github.com/MoonshotAI/kimi-code-app/pull/621) [`93af421`](https://github.com/MoonshotAI/kimi-code-app/commit/93af421ee7f381e5c8f54164cb95371be25eb6bf) - 修复会话较多时流式输出过程中界面反复卡顿、滚动不跟手的问题。

- [#545](https://github.com/MoonshotAI/kimi-code-app/pull/545) [`1578b77`](https://github.com/MoonshotAI/kimi-code-app/commit/1578b77dbd38e844d925c9ab94b66b8e0ba1ec64) - 终端标签直接显示当前运行的程序名称，方便区分多个终端。

- [#620](https://github.com/MoonshotAI/kimi-code-app/pull/620) [`e8eb822`](https://github.com/MoonshotAI/kimi-code-app/commit/e8eb8229c5912a1575f11fb93b170f73a6082d59) - 对话中的工具调用、思考过程和折叠摘要改为新的条带与卡片样式，展开后输出内容更清晰。

- [#606](https://github.com/MoonshotAI/kimi-code-app/pull/606) [`4e62de4`](https://github.com/MoonshotAI/kimi-code-app/commit/4e62de4a1bded1c8884565b1738400a7282dfb72) - 会话内容中的中文与英文、数字之间自动增加排版间距。

- [#601](https://github.com/MoonshotAI/kimi-code-app/pull/601) [`b3620e0`](https://github.com/MoonshotAI/kimi-code-app/commit/b3620e0f28ec663c8f4ea5a23db1f92d0e022261) - 本轮改动面板的打开文件按钮更换了新图标。

- [#601](https://github.com/MoonshotAI/kimi-code-app/pull/601) [`b3620e0`](https://github.com/MoonshotAI/kimi-code-app/commit/b3620e0f28ec663c8f4ea5a23db1f92d0e022261) - 本轮改动标签页的标题统一显示为「本轮改动」。

- [#588](https://github.com/MoonshotAI/kimi-code-app/pull/588) [`ccfcc05`](https://github.com/MoonshotAI/kimi-code-app/commit/ccfcc056bcbf7497d158a121b08e15d955bcc7d3) - 修复撤回消息的确认弹窗没说清撤销不影响文件和代码的问题。

- [#602](https://github.com/MoonshotAI/kimi-code-app/pull/602) [`a4a342a`](https://github.com/MoonshotAI/kimi-code-app/commit/a4a342a552c36b3e38a30d2a970953c1cae2537e) - 修复 Windows 贴图不显示、不置顶和边缘缩放失效的问题。

- [#602](https://github.com/MoonshotAI/kimi-code-app/pull/602) [`a4a342a`](https://github.com/MoonshotAI/kimi-code-app/commit/a4a342a552c36b3e38a30d2a970953c1cae2537e) - 修复 Windows 首次截图等待过久、任务栏重复显示和多屏缩放下窗口选区错位的问题。

- [#602](https://github.com/MoonshotAI/kimi-code-app/pull/602) [`a4a342a`](https://github.com/MoonshotAI/kimi-code-app/commit/a4a342a552c36b3e38a30d2a970953c1cae2537e) - 缩短 Windows 高分辨率和多屏截图的启动等待。

- [#602](https://github.com/MoonshotAI/kimi-code-app/pull/602) [`a4a342a`](https://github.com/MoonshotAI/kimi-code-app/commit/a4a342a552c36b3e38a30d2a970953c1cae2537e) - 修复 Windows 截图准备期间界面卡顿和辅助控制台闪现的问题。

- [#645](https://github.com/MoonshotAI/kimi-code-app/pull/645) [`08831c3`](https://github.com/MoonshotAI/kimi-code-app/commit/08831c35d40b3da3fc66cecea0c1b77155311860) - 修复 Windows 上部分目录路径导致文件监听进程崩溃的问题。

- [#617](https://github.com/MoonshotAI/kimi-code-app/pull/617) [`812a54a`](https://github.com/MoonshotAI/kimi-code-app/commit/812a54ac58f6a286091e8c33b3dd3708785fd683) - 修复重命名工作区后点击其他地方不会保存的问题。

## 0.0.26

### Patch Changes

- [#573](https://github.com/MoonshotAI/kimi-code-app/pull/573) [`eefa579`](https://github.com/MoonshotAI/kimi-code-app/commit/eefa57940e02328e749ffaf8a6b9bd422ab5938a) - 设置「关于」页新增用户协议与隐私协议入口。

- [#578](https://github.com/MoonshotAI/kimi-code-app/pull/578) [`185e62e`](https://github.com/MoonshotAI/kimi-code-app/commit/185e62e02668a7513e469587404ef1a001e1f440) - AI 会话标题正式启用：首轮对话后自动生成标题，重命名时可重新生成，无需再开实验开关。

- [#583](https://github.com/MoonshotAI/kimi-code-app/pull/583) [`79640ea`](https://github.com/MoonshotAI/kimi-code-app/commit/79640eace35222094ebb7f8d51d9c569cac4bc71) - 支持 AI 自动生成会话标题。

- [#554](https://github.com/MoonshotAI/kimi-code-app/pull/554) [`8c8f104`](https://github.com/MoonshotAI/kimi-code-app/commit/8c8f10445afcdd4506a4ff7f0e30014afdcf0e2d) - Canary 内测构建改为基于 dev 分支打包。

- [#539](https://github.com/MoonshotAI/kimi-code-app/pull/539) [`72cb015`](https://github.com/MoonshotAI/kimi-code-app/commit/72cb0156704e9e6390049857524ef0c2b4099c88) - 修复会话滚动条过细、难以点击拖动的问题。

- [#582](https://github.com/MoonshotAI/kimi-code-app/pull/582) [`20601f7`](https://github.com/MoonshotAI/kimi-code-app/commit/20601f7a3ac52f502796f16172d64820b103b44a) - 修复 Ctrl/Cmd+S 会把队列中所有消息合并发送的问题。

- [#555](https://github.com/MoonshotAI/kimi-code-app/pull/555) [`ebda1e4`](https://github.com/MoonshotAI/kimi-code-app/commit/ebda1e44e18f23ea1aafae6d4cdb857068937faf) - 修复恢复含大量括号或反斜杠的会话时加载卡住的问题。

- [#585](https://github.com/MoonshotAI/kimi-code-app/pull/585) [`d1e25d5`](https://github.com/MoonshotAI/kimi-code-app/commit/d1e25d592c548c3483fad0f2ca23f14bb31c8527) - 修复全局搜索仍显示已删除会话的问题。

- [#560](https://github.com/MoonshotAI/kimi-code-app/pull/560) [`1cc8a2a`](https://github.com/MoonshotAI/kimi-code-app/commit/1cc8a2a51e4eb4fb9381373c838ad700c6a4c1c3) - 修复长会话中流式输出时界面持续卡顿的问题。

- [#555](https://github.com/MoonshotAI/kimi-code-app/pull/555) [`ebda1e4`](https://github.com/MoonshotAI/kimi-code-app/commit/ebda1e44e18f23ea1aafae6d4cdb857068937faf) - 修复部分公式、链接、工具结果和日志内容导致界面卡顿或无响应的问题。

- [#574](https://github.com/MoonshotAI/kimi-code-app/pull/574) [`6af2f03`](https://github.com/MoonshotAI/kimi-code-app/commit/6af2f030b188a7ca57470ab628c9b0f66fc7f5aa) - 修复新建会话时发送按钮一直置灰无法发送的问题。

- [#562](https://github.com/MoonshotAI/kimi-code-app/pull/562) [`ac44a19`](https://github.com/MoonshotAI/kimi-code-app/commit/ac44a190d808a9daab81459089c2b0cb6d8a094b) - 修复新建对话后旧对话被误标为未读并弹出"回合完成"通知的问题。

- [#552](https://github.com/MoonshotAI/kimi-code-app/pull/552) [`e83e5eb`](https://github.com/MoonshotAI/kimi-code-app/commit/e83e5eba9260cc51231ef8f76c63c5a6432a6cac) - 修复后台任务通知在后续工具调用期间持续停留在会话底部的问题。

- [#544](https://github.com/MoonshotAI/kimi-code-app/pull/544) [`4a96008`](https://github.com/MoonshotAI/kimi-code-app/commit/4a96008245bd78b55a1d64b79e7616e5052490a5) - Preview 体验版使用独立绿色图标，方便与正式版和 Canary 区分。

- [#540](https://github.com/MoonshotAI/kimi-code-app/pull/540) [`da30ce4`](https://github.com/MoonshotAI/kimi-code-app/commit/da30ce45eed3aa5f971e9df5cc6c58d3b48bd6f7) - 支持与正式版及 Canary 并存安装的 Preview 体验版。

- [#535](https://github.com/MoonshotAI/kimi-code-app/pull/535) [`e7f9e48`](https://github.com/MoonshotAI/kimi-code-app/commit/e7f9e483ddb913c557bd9df544fa7386d2e2e2c0) - 修复刷新包含大量后台任务的会话时瞬间发出数百个请求、页面卡顿的问题。

- [#557](https://github.com/MoonshotAI/kimi-code-app/pull/557) [`0c0dbb8`](https://github.com/MoonshotAI/kimi-code-app/commit/0c0dbb8881ae0f8aa1b8614f42408fda068150d9) - Markdown 预览支持将文档元数据显示为键值卡片和标签列表。

- [#539](https://github.com/MoonshotAI/kimi-code-app/pull/539) [`72cb015`](https://github.com/MoonshotAI/kimi-code-app/commit/72cb0156704e9e6390049857524ef0c2b4099c88) - 减少长会话打开和回看时的卡顿，保留消息及工具的展开状态。

- [#569](https://github.com/MoonshotAI/kimi-code-app/pull/569) [`f1772a2`](https://github.com/MoonshotAI/kimi-code-app/commit/f1772a2808ffa760a65c8ece37513c8e27597a5c) - 修复安装版应用中新会话页动画和桌面吉祥物无法显示的问题。

- [#528](https://github.com/MoonshotAI/kimi-code-app/pull/528) [`1d6e14f`](https://github.com/MoonshotAI/kimi-code-app/commit/1d6e14f69e480459565a574815ca49a0503f5717) - 支持在会话右键菜单中永久删除会话，删除前会弹窗确认。

- [#573](https://github.com/MoonshotAI/kimi-code-app/pull/573) [`eefa579`](https://github.com/MoonshotAI/kimi-code-app/commit/eefa57940e02328e749ffaf8a6b9bd422ab5938a) - 调整设置页结构：「账户」前移到「通用」之后，「Agent」改名「智能体与会话」并纳入消息折叠设置，「高级」改名「关于」，数据与隐私设置移入「通用」。

- [#542](https://github.com/MoonshotAI/kimi-code-app/pull/542) [`6136981`](https://github.com/MoonshotAI/kimi-code-app/commit/61369810b366fd07a06270cf8d02e1dc325d5c29) - 修复会话进行中新建的 skill 要重启才能出现在 slash 列表的问题。

- [#538](https://github.com/MoonshotAI/kimi-code-app/pull/538) [`734f7b6`](https://github.com/MoonshotAI/kimi-code-app/commit/734f7b6bd8a6396955a8c8ac4563e5eb70bc567a) - 修复代码块流式输出时末尾反引号短暂闪现的问题。

- [#556](https://github.com/MoonshotAI/kimi-code-app/pull/556) [`7eedcdb`](https://github.com/MoonshotAI/kimi-code-app/commit/7eedcdb10d8d8d8d1509b03636db84b0f926b598) - 修复设置页分段选择器加载时选中底板闪烁、偏移的问题。

- [#565](https://github.com/MoonshotAI/kimi-code-app/pull/565) [`9d01f79`](https://github.com/MoonshotAI/kimi-code-app/commit/9d01f7959a7b606b27fd141ffa9b99b35ed6649b) - 修复开关滑块悬停拉伸时两端变形的问题。

- [#575](https://github.com/MoonshotAI/kimi-code-app/pull/575) [`3b09ed0`](https://github.com/MoonshotAI/kimi-code-app/commit/3b09ed09de30054a39902875e7331942b484adf1) - 修复鼠标未移动时 tooltip 无故弹出的问题。

- [#559](https://github.com/MoonshotAI/kimi-code-app/pull/559) [`80fb495`](https://github.com/MoonshotAI/kimi-code-app/commit/80fb495e39ba66420427f492331df744c691de34) - ⌘W（Windows/Linux 为 Ctrl+W）不再直接关闭窗口：先关闭当前会话页面回到新建会话页，再按一次才关闭窗口，可在设置 → 快捷键中改绑。

- [#532](https://github.com/MoonshotAI/kimi-code-app/pull/532) [`02676c9`](https://github.com/MoonshotAI/kimi-code-app/commit/02676c98e103ff2110ddb1b3452f4429a5a63244) - Composer 现以可排序的媒体栏集中预览图片和视频，支持按需在正文中提及，并在排队和发送后保留预览。

## 0.0.25

### 新功能

- 新增 tower 多智能体协作模式（实验），/tower 或加号菜单开启。
- 新增划词标注：选中消息、预览、diff 或终端的文字，可添加评论或引用到对话。

### 优化

- 三档权限模式更名为「始终询问 / 必要时询问 / 完全自动」，描述文案同步更新。
- Esc 不再关闭右侧详情面板。
- 优化 Bash 命令在右侧面板的样式交互。

### 修复

- 修复文件改动预览中增删行统计不准确、可能凭空出现的问题。
- 修复后台 Agent 的消息卡片误显示运行中指示的问题。
- 修复设置中默认思考强度无法设为最高档（Max）的问题。

## 0.0.24

### Patch Changes

- [#498](https://github.com/MoonshotAI/kimi-code-app/pull/498) [`6277463`](https://github.com/MoonshotAI/kimi-code-app/commit/6277463e85183d965aa6d96abc02ffa05bb4773e) - 内置 Kimi Code 更新至 main 最新 commit a23ff5635。

- [#472](https://github.com/MoonshotAI/kimi-code-app/pull/472) [`60ff93f`](https://github.com/MoonshotAI/kimi-code-app/commit/60ff93f9cbcf125fa5181fe4c5481a181a10847b) - 升级内置 Kimi Code 到 0.39.1，修复权限模式在不同会话间互相影响、工作区较多时启动长时间卡在连接中等多项问题。

- [#468](https://github.com/MoonshotAI/kimi-code-app/pull/468) [`02620fa`](https://github.com/MoonshotAI/kimi-code-app/commit/02620fa7772bc207bc3127996aa0b4db1ae0e4d3) - 修复自动压缩后新内容不显示（分隔线后一直「请求中…」）：压缩点之后的输出现在渲染在分隔线下方。

- [#446](https://github.com/MoonshotAI/kimi-code-app/pull/446) [`94fdd4b`](https://github.com/MoonshotAI/kimi-code-app/commit/94fdd4b3fb7eeeced083ad0fa321e05162c53e02) - 连接中的启动页现在显示当前加载阶段，连接失败时显示原因。

- [#458](https://github.com/MoonshotAI/kimi-code-app/pull/458) [`4fc48bf`](https://github.com/MoonshotAI/kimi-code-app/commit/4fc48bfdc905f6ad49350f9b08d6dc29d268f891) - 移除了侧栏长按 logo 打开的设计系统文档页。

- [#466](https://github.com/MoonshotAI/kimi-code-app/pull/466) [`7931c93`](https://github.com/MoonshotAI/kimi-code-app/commit/7931c93f92b0d7d2ea13a797276c626d2351c994) - 修复排队或插队发送的消息开始运行后，按 Esc 会被意外撤回的问题。

- [#482](https://github.com/MoonshotAI/kimi-code-app/pull/482) [`6417476`](https://github.com/MoonshotAI/kimi-code-app/commit/6417476efbfa55aa2604d42bf594e218f1c55131) - 在预览右侧边栏文件变动时显示刷新按钮。

- [#428](https://github.com/MoonshotAI/kimi-code-app/pull/428) [`050ceb6`](https://github.com/MoonshotAI/kimi-code-app/commit/050ceb6d4d255a3ea09ae5122f6187a8cb44d2e5) - 修复发送文件后自己的消息气泡里露出附件服务端说明原文的问题。

- [#478](https://github.com/MoonshotAI/kimi-code-app/pull/478) [`c443461`](https://github.com/MoonshotAI/kimi-code-app/commit/c443461fea05ca341b4f0b4c059b6e5c7243d9be) - 修复 Composer 附件提示中内容未对齐的问题。

- [#445](https://github.com/MoonshotAI/kimi-code-app/pull/445) [`07c23ac`](https://github.com/MoonshotAI/kimi-code-app/commit/07c23acd142545c928e6e7088020eda8640199dc) - 修复 Agent 运行中用 Ctrl+S 发送的消息在刷新页面后消失的问题。

- [#486](https://github.com/MoonshotAI/kimi-code-app/pull/486) [`d13daf1`](https://github.com/MoonshotAI/kimi-code-app/commit/d13daf13432ae5da31fcaa87b26e1e1bf563b179) - 修复中途追加消息后会话偶尔一直显示「工作中」的问题。

- [#442](https://github.com/MoonshotAI/kimi-code-app/pull/442) [`9dd9a78`](https://github.com/MoonshotAI/kimi-code-app/commit/9dd9a78c59c7c21228ace6c9faeabec081b4e9c0) - 修复开启目标或计划模式后中文输入法首个拼音字母被输入为英文的问题。

- [#464](https://github.com/MoonshotAI/kimi-code-app/pull/464) [`65e9410`](https://github.com/MoonshotAI/kimi-code-app/commit/65e941076aba850cbfa2b6f5524ee8bb3e9987e7) - 修复会话偶尔一直显示「工作中」、实际早已回复完成的问题。

- [#425](https://github.com/MoonshotAI/kimi-code-app/pull/425) [`f03174a`](https://github.com/MoonshotAI/kimi-code-app/commit/f03174a8ef50c9c86ad91d7f0ac5cc3acea2a00e) - @ 文件菜单中按 Tab 键可把高亮候选项的名称补全到输入中，菜单保持打开继续过滤。

- [#423](https://github.com/MoonshotAI/kimi-code-app/pull/423) [`9ff0862`](https://github.com/MoonshotAI/kimi-code-app/commit/9ff086226b961eb5a70252a345cf945e8b5c202f) - 支持在一条消息中同时激活多个技能。

- [#453](https://github.com/MoonshotAI/kimi-code-app/pull/453) [`4c98cd4`](https://github.com/MoonshotAI/kimi-code-app/commit/4c98cd499b9f8e513532a01febffc6b35856a630) - 后台任务通知卡的来源行改为「由后台发送 · bash」，卡片内文重组为一行「状态：任务描述」。

- [#484](https://github.com/MoonshotAI/kimi-code-app/pull/484) [`6c1bacb`](https://github.com/MoonshotAI/kimi-code-app/commit/6c1bacb86fbca9c4c4b46ee0d1e1a34ad3c34f0b) - 后台任务通知卡的来源行改为「由后台发送（Bash）/（Agent）」。

- [#424](https://github.com/MoonshotAI/kimi-code-app/pull/424) [`c6f7dbf`](https://github.com/MoonshotAI/kimi-code-app/commit/c6f7dbf676bb2253a20ab8eff894feb8e8272887) - 快速连续输入 @ 文件名时及时取消过期搜索，减少后台占用。

- [#450](https://github.com/MoonshotAI/kimi-code-app/pull/450) [`4fcb388`](https://github.com/MoonshotAI/kimi-code-app/commit/4fcb3884daa17fd7eff995544f8f563fba17d783) - 修复消息里手打的 > 引用块被误显示为引用标注的问题，现在按普通文本显示。

- [#479](https://github.com/MoonshotAI/kimi-code-app/pull/479) [`b148ad5`](https://github.com/MoonshotAI/kimi-code-app/commit/b148ad57808e531b6d9c5fa3d57db99c8139fd08) - 修复 macOS 上 ⌘H 无法隐藏应用及系统原生应用菜单项缺失的问题。

- [#467](https://github.com/MoonshotAI/kimi-code-app/pull/467) [`b12cde8`](https://github.com/MoonshotAI/kimi-code-app/commit/b12cde85c7a8fb4d016284012e8611115cc80d05) - 优化右侧边栏文件打开方式。

- [#460](https://github.com/MoonshotAI/kimi-code-app/pull/460) [`bf76f31`](https://github.com/MoonshotAI/kimi-code-app/commit/bf76f314fedf2b7db666a8e3dd0cc8e1d61e615b) - 修复发送被服务器拒绝时可能不显示任何失败提示的问题。

- [#422](https://github.com/MoonshotAI/kimi-code-app/pull/422) [`060b744`](https://github.com/MoonshotAI/kimi-code-app/commit/060b744733abee26e87795f89ed9fbae81dd2432) - 从斜杠菜单选择技能时插入与 @ 菜单一致的技能标签。

- [#496](https://github.com/MoonshotAI/kimi-code-app/pull/496) [`af64e02`](https://github.com/MoonshotAI/kimi-code-app/commit/af64e021909a5e4f82b9e510ed616f5a4717b3a4) - 修复 steer 消息导致文件修改汇总卡片提前显示的问题。

- [#465](https://github.com/MoonshotAI/kimi-code-app/pull/465) [`acc3530`](https://github.com/MoonshotAI/kimi-code-app/commit/acc3530db1e95b13ef550e21a0c804a167bc9d1a) - 修复压缩后上下文用量圆环不刷新的问题，会话用量改为随 transcript 元数据实时更新。

- [#485](https://github.com/MoonshotAI/kimi-code-app/pull/485) [`21076c9`](https://github.com/MoonshotAI/kimi-code-app/commit/21076c9a858d8a25eda5c2b716c640cfa8e4161d) - Web 版设置新增「插件」面板，可浏览插件市场并安装、启停、移除插件。

## 0.0.22

### Patch Changes

- [#438](https://github.com/MoonshotAI/kimi-code-app/pull/438) [`c3e7e59`](https://github.com/MoonshotAI/kimi-code-app/commit/c3e7e59f59d82fceaf0f45624ff496fe9f3d021b) - 修复执行命令时工具行高度明显大于其他工具行的问题。

- [#429](https://github.com/MoonshotAI/kimi-code-app/pull/429) [`a7e0202`](https://github.com/MoonshotAI/kimi-code-app/commit/a7e020294e28957d82b14d477870a47f18665523) - 修复在空输入框点击占位文字后，输入法（及键盘）首个字符被静默吞掉的问题。

- [#383](https://github.com/MoonshotAI/kimi-code-app/pull/383) [`0c9d15b`](https://github.com/MoonshotAI/kimi-code-app/commit/0c9d15ba92fa7be935ed2509c5721004864ab11f) - 优化权限模式状态管理

- [#436](https://github.com/MoonshotAI/kimi-code-app/pull/436) [`2139742`](https://github.com/MoonshotAI/kimi-code-app/commit/2139742c91c097a1e26cec7044970067a7e3d736) - 修复图片和视频附件预览浮窗闪烁及交互异常的问题。

- [#432](https://github.com/MoonshotAI/kimi-code-app/pull/432) [`fb9d803`](https://github.com/MoonshotAI/kimi-code-app/commit/fb9d8038f40f2f3763c653bed9e67c88ba288d90) - 修复新建会话中附件上传完成后仍显示正在上传的问题。

- [#439](https://github.com/MoonshotAI/kimi-code-app/pull/439) [`6f8f60f`](https://github.com/MoonshotAI/kimi-code-app/commit/6f8f60ffe48f042a4464a43d03bfd08aff591317) - 修复空输入框点击占位提示后，首个键盘或输入法字符可能被吞掉的问题。

- [#420](https://github.com/MoonshotAI/kimi-code-app/pull/420) [`8eedeff`](https://github.com/MoonshotAI/kimi-code-app/commit/8eedeff72423c4bc04305804d87ed2669fae23a8) - 优化右侧边栏交互。

- [#433](https://github.com/MoonshotAI/kimi-code-app/pull/433) [`4c55a50`](https://github.com/MoonshotAI/kimi-code-app/commit/4c55a50c08988066a14b4a0891bed74200323124) - 修复工作区数量很多时启动长时间卡在「连接中」的问题。

## 0.0.21

### Patch Changes

- [#404](https://github.com/MoonshotAI/kimi-code-app/pull/404) [`a2cde90`](https://github.com/MoonshotAI/kimi-code-app/commit/a2cde9083540721c66d18111a246f7238f35faee) - 添加工作区时兼容带引号的路径（如 Windows「复制为路径」）。

- [#284](https://github.com/MoonshotAI/kimi-code-app/pull/284) [`54df746`](https://github.com/MoonshotAI/kimi-code-app/commit/54df746a323776a9206121a6c200c276a2afc329) - 优化右侧面板中的 subagent 交互。

- [#333](https://github.com/MoonshotAI/kimi-code-app/pull/333) [`557fa6a`](https://github.com/MoonshotAI/kimi-code-app/commit/557fa6aa7360d3b381a2223ed31a61b4e3e6baa2) - 修复切换会话后输入框里还没传完的图片丢失的问题。

- [#372](https://github.com/MoonshotAI/kimi-code-app/pull/372) [`2f13c07`](https://github.com/MoonshotAI/kimi-code-app/commit/2f13c07bb4683455fc158813dff8268bfb108db7) - 设置里的加油包余额一栏改为只显示余额，不再显示总额分母。

- [#421](https://github.com/MoonshotAI/kimi-code-app/pull/421) [`10e8d2e`](https://github.com/MoonshotAI/kimi-code-app/commit/10e8d2e462a08dce0645f3f376bbbd2a66c9026d) - 升级内置 Kimi Code 到 0.39.0，支持实验性远程控制，并修复会话归档、中断会话恢复崩溃等多项问题。

- [#377](https://github.com/MoonshotAI/kimi-code-app/pull/377) [`f0448ec`](https://github.com/MoonshotAI/kimi-code-app/commit/f0448ec81559f53d913fda5ec6468bea3a6e8d58) - Kimi Code Canary 的更新改为应用内一键增量更新：只下载变化的部分（通常十几 MB），下完一键重启安装，不再需要手动下载安装包。

- [#397](https://github.com/MoonshotAI/kimi-code-app/pull/397) [`1821f9a`](https://github.com/MoonshotAI/kimi-code-app/commit/1821f9ab4631ebcdfebccf2ec61ac5e5f97a49b1) - Canary 支持从正式版导入界面设置（置顶、外观等 localStorage 偏好），在 debug 菜单中使用。

- [#283](https://github.com/MoonshotAI/kimi-code-app/pull/283) [`070ec2c`](https://github.com/MoonshotAI/kimi-code-app/commit/070ec2c64126f568f42f8547f6e071d3c86e7d4c) - 会话头部的终端与右侧面板开关固定在最右侧同一位置，窗口变窄时自动隐藏分支与 PR 信息。

- [#364](https://github.com/MoonshotAI/kimi-code-app/pull/364) [`aa73baa`](https://github.com/MoonshotAI/kimi-code-app/commit/aa73baa1b237c5d72eac37a65edd8382bfb61b04) - 优化代码块交互与显示。

- [#364](https://github.com/MoonshotAI/kimi-code-app/pull/364) [`aa73baa`](https://github.com/MoonshotAI/kimi-code-app/commit/aa73baa1b237c5d72eac37a65edd8382bfb61b04) - 优化输入框交互。

- [#368](https://github.com/MoonshotAI/kimi-code-app/pull/368) [`9a4d500`](https://github.com/MoonshotAI/kimi-code-app/commit/9a4d50046fafd0d5b0de5bdf443367b7c7e37757) - debug 入口的标识改为显示当前分支名（如 main），点开还能看到版本号、commit 和精确构建时间。

- [#364](https://github.com/MoonshotAI/kimi-code-app/pull/364) [`aa73baa`](https://github.com/MoonshotAI/kimi-code-app/commit/aa73baa1b237c5d72eac37a65edd8382bfb61b04) - 优化桌面端交互体验。

- [#364](https://github.com/MoonshotAI/kimi-code-app/pull/364) [`aa73baa`](https://github.com/MoonshotAI/kimi-code-app/commit/aa73baa1b237c5d72eac37a65edd8382bfb61b04) - 修复反复切换会话或反复开关右侧面板后内存占用持续增长的问题。

- [#406](https://github.com/MoonshotAI/kimi-code-app/pull/406) [`b8a9f74`](https://github.com/MoonshotAI/kimi-code-app/commit/b8a9f748f231521eec1d5ebef7cd9ccb968328da) - 修复侧边栏多 Tab 或全屏切换时，划词评论输入框位置错乱或意外消失的问题。

- [#406](https://github.com/MoonshotAI/kimi-code-app/pull/406) [`b8a9f74`](https://github.com/MoonshotAI/kimi-code-app/commit/b8a9f748f231521eec1d5ebef7cd9ccb968328da) - 修复侧聊中划词引用后继续输入的文字在发送后错误显示为引用评论的问题。

- [#419](https://github.com/MoonshotAI/kimi-code-app/pull/419) [`758f458`](https://github.com/MoonshotAI/kimi-code-app/commit/758f4587d10e28de8ac04678df8e379ca0f10387) - 暂时下线划词标注功能，选择文本不再弹出评论或添加到对话的气泡。

- [#358](https://github.com/MoonshotAI/kimi-code-app/pull/358) [`dbba312`](https://github.com/MoonshotAI/kimi-code-app/commit/dbba312abdd394f8a9af82a140b39f2b52916c57) - 新增 Kimi Code Canary 内测版（黄色图标，与正式版并存安装），侧栏会提示有新的内测构建并可一键下载，设置页可手动检查更新或触发新构建，还可在其中直接预览任意 PR 或分支的界面。

- [#381](https://github.com/MoonshotAI/kimi-code-app/pull/381) [`13de9e3`](https://github.com/MoonshotAI/kimi-code-app/commit/13de9e3ecea6db31e4c8031cb49b78ff84e78a00) - 图片和视频也可以像文件一样直接拖进输入框变成附件发送，悬停可预览和全屏查看，还能实时看到上传进度。

- [#366](https://github.com/MoonshotAI/kimi-code-app/pull/366) [`7e38870`](https://github.com/MoonshotAI/kimi-code-app/commit/7e388705893c39c473ef245c4bda9b0c3c5f60b2) - 设置 → 高级新增两个折叠开关：消息自动折叠（默认关闭）和工具调用汇总（默认开启）。

- [#411](https://github.com/MoonshotAI/kimi-code-app/pull/411) [`b346da9`](https://github.com/MoonshotAI/kimi-code-app/commit/b346da9bb20935c7a539f6ab3dcba853e13d095d) - 在授权页取消登录时显示明确的已取消状态，不再卡在等待页或误报连接断开。

- [#384](https://github.com/MoonshotAI/kimi-code-app/pull/384) [`46aa7dd`](https://github.com/MoonshotAI/kimi-code-app/commit/46aa7dd1fc16d524490390ec5fe3dab03a0fb9a3) - PR 预览时，窗口左上角的 debug pill 会显示正在预览的分支或 PR。

- [#378](https://github.com/MoonshotAI/kimi-code-app/pull/378) [`05e1780`](https://github.com/MoonshotAI/kimi-code-app/commit/05e1780188016f9d41ce6afad9644f2e4248f9ad) - PR 预览改为在独立窗口中打开，不再替换当前窗口的内容。

- [#403](https://github.com/MoonshotAI/kimi-code-app/pull/403) [`3c43ae0`](https://github.com/MoonshotAI/kimi-code-app/commit/3c43ae00cba5c7405823de599b61c60f6e1c5e6a) - 修复问题卡片选项字段（多选、Other 标签与描述）丢失的问题

- [#400](https://github.com/MoonshotAI/kimi-code-app/pull/400) [`1bba6e5`](https://github.com/MoonshotAI/kimi-code-app/commit/1bba6e531c1e3032249efb7c173d05f89f97c8f9) - 划词标注：操作弹窗跟随指针显示，多个标注可在同一行排列，悬停详情卡片中引用和评论可分开复制。

- [#418](https://github.com/MoonshotAI/kimi-code-app/pull/418) [`79f6a8a`](https://github.com/MoonshotAI/kimi-code-app/commit/79f6a8a911c037c2bcc29d628e351aebc3ecc29d) - 划词引用标注的蓝色与链接颜色统一，引用和评论之间改用间隔号分隔。

- [#386](https://github.com/MoonshotAI/kimi-code-app/pull/386) [`f1c73b9`](https://github.com/MoonshotAI/kimi-code-app/commit/f1c73b90d9242facf0a5eacec240c7c1785855a5) - 发出的消息里大段引用折叠为引用 chip：评论和引用合并为一个整体显示（与输入框一致），悬停即可查看完整引用和评论。

- [#408](https://github.com/MoonshotAI/kimi-code-app/pull/408) [`e588360`](https://github.com/MoonshotAI/kimi-code-app/commit/e58836035df8754adb336bcd9c8cc3c63b17a7d7) - 划词标注的引用标签改版：更精致的浅蓝小胶囊，评论以蓝色显示，字号略小、留白更舒展。

- [#416](https://github.com/MoonshotAI/kimi-code-app/pull/416) [`c51a572`](https://github.com/MoonshotAI/kimi-code-app/commit/c51a572b1bd88cb27a0854dbf196fda30b919a8f) - 划词引用标注改为无底色的蓝色文字样式，与文件提及样式统一。

- [#386](https://github.com/MoonshotAI/kimi-code-app/pull/386) [`f1c73b9`](https://github.com/MoonshotAI/kimi-code-app/commit/f1c73b90d9242facf0a5eacec240c7c1785855a5) - 从文件预览划词标注时，引用会附带文件路径和行号来源，方便模型定位出处。

- [#416](https://github.com/MoonshotAI/kimi-code-app/pull/416) [`c51a572`](https://github.com/MoonshotAI/kimi-code-app/commit/c51a572b1bd88cb27a0854dbf196fda30b919a8f) - 去掉划词菜单里的「添加到侧聊」入口，划词只保留评论与添加到对话。

- [#283](https://github.com/MoonshotAI/kimi-code-app/pull/283) [`070ec2c`](https://github.com/MoonshotAI/kimi-code-app/commit/070ec2c64126f568f42f8547f6e071d3c86e7d4c) - 优化右侧边栏，改为多标签页形式。

- [#373](https://github.com/MoonshotAI/kimi-code-app/pull/373) [`175c9a2`](https://github.com/MoonshotAI/kimi-code-app/commit/175c9a21a468bca78ca09cfbf6eefc3683836d42) - 划词操作气泡默认显示在选区下方（下方空间不足时才翻到上方），操作更顺手。

- [#364](https://github.com/MoonshotAI/kimi-code-app/pull/364) [`aa73baa`](https://github.com/MoonshotAI/kimi-code-app/commit/aa73baa1b237c5d72eac37a65edd8382bfb61b04) - 新增划选内容并添加到当前对话或侧聊的功能。

- [#352](https://github.com/MoonshotAI/kimi-code-app/pull/352) [`8de46e9`](https://github.com/MoonshotAI/kimi-code-app/commit/8de46e91bb59391d535f11fb297bc7a41db7aa8f) - 新会话现在会遵循 Settings 里配置的默认思考档位，不再总是回退到模型目录的默认值。

- [#389](https://github.com/MoonshotAI/kimi-code-app/pull/389) [`ecb681c`](https://github.com/MoonshotAI/kimi-code-app/commit/ecb681cebaf4ee4095e9d44673fd91bf5de17bb5) - 修复点击侧边栏会话后，其时间被错误刷新成“刚刚”并跳到列表顶部的问题。

- [#349](https://github.com/MoonshotAI/kimi-code-app/pull/349) [`ff3e73b`](https://github.com/MoonshotAI/kimi-code-app/commit/ff3e73b79e3ca56eb1be9b0b66037e13ac4a14a2) - 设置里的"默认思考"从单一开关改为分档控件：当默认模型支持思考档位（如 low/high/max）时可直接选择具体档位，不再只能开/关。

- [#363](https://github.com/MoonshotAI/kimi-code-app/pull/363) [`643f94d`](https://github.com/MoonshotAI/kimi-code-app/commit/643f94d57bc8871074bd1766a522a70a297358d3) - 修复侧聊在上一轮完成与新一轮发送交错时偶发提前结束或串入旧输出的问题。

- [#361](https://github.com/MoonshotAI/kimi-code-app/pull/361) [`254369a`](https://github.com/MoonshotAI/kimi-code-app/commit/254369a4ad47fef315b5c804033876de111bdf67) - 修复侧聊偶发卡死在“发送中”以及回复内容重复的问题。

- [#398](https://github.com/MoonshotAI/kimi-code-app/pull/398) [`b18bb79`](https://github.com/MoonshotAI/kimi-code-app/commit/b18bb799187f1481fc48585d0b3ced420289cf45) - 修复直接发送无参数的 skill 斜杠命令（如 /update-config）时，气泡在 skill 名后面重复显示原始命令文本的问题（该文本也曾被一并当作 skill 参数发给模型）。

- [#361](https://github.com/MoonshotAI/kimi-code-app/pull/361) [`254369a`](https://github.com/MoonshotAI/kimi-code-app/commit/254369a4ad47fef315b5c804033876de111bdf67) - 修复技能还在执行时队列里的下一条消息被提前发出的问题。

- [#403](https://github.com/MoonshotAI/kimi-code-app/pull/403) [`3c43ae0`](https://github.com/MoonshotAI/kimi-code-app/commit/3c43ae00cba5c7405823de599b61c60f6e1c5e6a) - 修复 steer 消息在聊天中不显示的问题

- [#407](https://github.com/MoonshotAI/kimi-code-app/pull/407) [`113e274`](https://github.com/MoonshotAI/kimi-code-app/commit/113e2744d548ca027b85e5d433b371e6c37c05b0) - 修复 steer 消息在生成期间重复显示或丢失的问题

- [#417](https://github.com/MoonshotAI/kimi-code-app/pull/417) [`3a4f824`](https://github.com/MoonshotAI/kimi-code-app/commit/3a4f824afd19061b16a5e17f1a0842720db2aa68) - 修复 steer 消息无法撤回、且导致更早消息撤回时少撤一轮的问题。

- [#401](https://github.com/MoonshotAI/kimi-code-app/pull/401) [`a87ccaf`](https://github.com/MoonshotAI/kimi-code-app/commit/a87ccaf8b13b89e6fdf01dc5e1e39446f6788d0a) - 支持将正在运行的前台 Bash 命令和子代理转为后台任务，点击运行中卡片上的「转为后台」按钮即可。

- [#361](https://github.com/MoonshotAI/kimi-code-app/pull/361) [`254369a`](https://github.com/MoonshotAI/kimi-code-app/commit/254369a4ad47fef315b5c804033876de111bdf67) - 修复前台子代理的任务被错误标记为后台运行的问题。

- [#380](https://github.com/MoonshotAI/kimi-code-app/pull/380) [`8d829ab`](https://github.com/MoonshotAI/kimi-code-app/commit/8d829ab895a0be1ede90db9aaa02081412e2c249) - 思考时长改为从首个可见思考内容起算，不再把模型排队与首 token 等待计入

- [#405](https://github.com/MoonshotAI/kimi-code-app/pull/405) [`40630dd`](https://github.com/MoonshotAI/kimi-code-app/commit/40630ddb43e2b827b4605be037bc69e3bccff7c3) - 修复弹窗突然出现或窗口切回前台时，光标处无故弹出工具提示的问题。

- [#365](https://github.com/MoonshotAI/kimi-code-app/pull/365) [`7401c92`](https://github.com/MoonshotAI/kimi-code-app/commit/7401c92c31cc8119adceec3ab99db8df1855fe21) - 修复历史分页与内容刷新同时发生时偶发消息状态被旧数据覆盖的问题。

- [#364](https://github.com/MoonshotAI/kimi-code-app/pull/364) [`aa73baa`](https://github.com/MoonshotAI/kimi-code-app/commit/aa73baa1b237c5d72eac37a65edd8382bfb61b04) - 修复切换会话或断线重连后消息重复、丢失及会话状态未及时更新的问题。

- [#361](https://github.com/MoonshotAI/kimi-code-app/pull/361) [`254369a`](https://github.com/MoonshotAI/kimi-code-app/commit/254369a4ad47fef315b5c804033876de111bdf67) - 修复快速切换会话后偶发消息状态过期、历史或侧聊内容重复的问题。

- [#402](https://github.com/MoonshotAI/kimi-code-app/pull/402) [`fb00ace`](https://github.com/MoonshotAI/kimi-code-app/commit/fb00ace929798f61839d91f7d9c86a99c369db52) - 撤回编辑支持撤回到任意一条用户消息。

- [#364](https://github.com/MoonshotAI/kimi-code-app/pull/364) [`aa73baa`](https://github.com/MoonshotAI/kimi-code-app/commit/aa73baa1b237c5d72eac37a65edd8382bfb61b04) - 优化 Web 移动端交互。

## 0.0.20

### Patch Changes

- [#275](https://github.com/MoonshotAI/kimi-code-app/pull/275) [`fcd48d4`](https://github.com/MoonshotAI/kimi-code-app/commit/fcd48d438d71f05b92e6072a111e379dadf5157b) - 消息流里的子代理卡片现在会标注「前台」或「后台」。

- [#277](https://github.com/MoonshotAI/kimi-code-app/pull/277) [`2eaf627`](https://github.com/MoonshotAI/kimi-code-app/commit/2eaf6275fcd5b578be0dac499aa8c24639c0961d) - 修复输入框工具条在窗口很窄时按钮互相挤压遮挡的问题。

- [#268](https://github.com/MoonshotAI/kimi-code-app/pull/268) [`89a7946`](https://github.com/MoonshotAI/kimi-code-app/commit/89a79466c3a881fa5f77b3e6603fabffd7a4b0ae) - 设置里的服务端版本和服务器地址旁边新增复制按钮，一键复制对应信息。

- [#280](https://github.com/MoonshotAI/kimi-code-app/pull/280) [`afae048`](https://github.com/MoonshotAI/kimi-code-app/commit/afae048dad06d5c32536183a88f0e12350ff2861) - 修复归档最后一个会话后工作区从侧边栏消失的问题。

- [#292](https://github.com/MoonshotAI/kimi-code-app/pull/292) [`b6af878`](https://github.com/MoonshotAI/kimi-code-app/commit/b6af8789d71ec04502da0331ce6a9591e28db871) - 修复打开下拉菜单后按钮的悬停提示仍停留在菜单上方的问题。

- [#263](https://github.com/MoonshotAI/kimi-code-app/pull/263) [`86b67a6`](https://github.com/MoonshotAI/kimi-code-app/commit/86b67a6b2cc358729dcd1119518b485d0798dbdb) - 修复工作空间主页模型选择菜单显示不全的问题。

- [#298](https://github.com/MoonshotAI/kimi-code-app/pull/298) [`5ef5e67`](https://github.com/MoonshotAI/kimi-code-app/commit/5ef5e6733becdbaa990ff00f1319b3eb67fb77f6) - 修复搜索弹窗里工作区分组标题显示为未翻译文本的问题。

- [#269](https://github.com/MoonshotAI/kimi-code-app/pull/269) [`323fc9f`](https://github.com/MoonshotAI/kimi-code-app/commit/323fc9f520beeda60cc34bd3b2cbf8a871b73f06) - 修复设置对话框里的下拉选择列表会被滚动区域截断、展开时背后内容仍在滚动的问题。

- [#263](https://github.com/MoonshotAI/kimi-code-app/pull/263) [`86b67a6`](https://github.com/MoonshotAI/kimi-code-app/commit/86b67a6b2cc358729dcd1119518b485d0798dbdb) - 修复工作空间主页斜杠命令和 @ 面板显示不全的问题。

- [#267](https://github.com/MoonshotAI/kimi-code-app/pull/267) [`90e7cdf`](https://github.com/MoonshotAI/kimi-code-app/commit/90e7cdffeeededc05a8b29cc9740dfcab3a4596d) - 修复侧边栏用户菜单及套餐用量子菜单里的文字可以被鼠标拖选高亮的问题。

- [#289](https://github.com/MoonshotAI/kimi-code-app/pull/289) [`866bb62`](https://github.com/MoonshotAI/kimi-code-app/commit/866bb62dffef105a685a805cd655cdd4c4206962) - 修复工作区较多时会话列表加载缓慢的问题。

- [#215](https://github.com/MoonshotAI/kimi-code-app/pull/215) [`f0a7f5a`](https://github.com/MoonshotAI/kimi-code-app/commit/f0a7f5a0d97ebcd332977f86f43c3b2bb4dbf112) - 登录选区后自动打开浏览器授权页并重设计授权等待页；应用被授权深链唤起或窗口重新聚焦时立即刷新登录状态，不再等待轮询周期。

- [#266](https://github.com/MoonshotAI/kimi-code-app/pull/266) [`03af189`](https://github.com/MoonshotAI/kimi-code-app/commit/03af18953b4bcbbf7ff78c7b880fafbf35b8b198) - @ 菜单升级：文件与技能候选合并按匹配度排序，文件搜索更快，支持路径片段匹配与命中字符高亮。

- [#295](https://github.com/MoonshotAI/kimi-code-app/pull/295) [`1d0ade7`](https://github.com/MoonshotAI/kimi-code-app/commit/1d0ade75077aa778dc42485f8cae8e617f25245e) - 修复菜单项与菜单边框圆角不同心的问题。

- [#302](https://github.com/MoonshotAI/kimi-code-app/pull/302) [`ad8a98f`](https://github.com/MoonshotAI/kimi-code-app/commit/ad8a98ff10c3f17dbcd6d67d3a3131e5645586e6) - 优化移动端样式。

- [#277](https://github.com/MoonshotAI/kimi-code-app/pull/277) [`2eaf627`](https://github.com/MoonshotAI/kimi-code-app/commit/2eaf6275fcd5b578be0dac499aa8c24639c0961d) - 空间不足时输入框的模型选择器会折叠为图标，悬停仍可查看模型与推理强度。

- [#277](https://github.com/MoonshotAI/kimi-code-app/pull/277) [`2eaf627`](https://github.com/MoonshotAI/kimi-code-app/commit/2eaf6275fcd5b578be0dac499aa8c24639c0961d) - 修复输入框空间充足时权限模式文字被隐藏的问题。

- [#296](https://github.com/MoonshotAI/kimi-code-app/pull/296) [`f6942c0`](https://github.com/MoonshotAI/kimi-code-app/commit/f6942c06d917e13b137d948b1fd1c11605b8fdd0) - 会话右上角「...」菜单新增「置顶」，一键把当前会话固定到侧栏置顶区。

- [#270](https://github.com/MoonshotAI/kimi-code-app/pull/270) [`97421a6`](https://github.com/MoonshotAI/kimi-code-app/commit/97421a6bca51bd6b542d4042bc4636b7105f9188) - 侧边栏置顶会话较多时，可拖动置顶区与会话列表之间的分隔条调整两个区域的高度，置顶区内部滚动时边缘会显示渐隐提示。

- [#299](https://github.com/MoonshotAI/kimi-code-app/pull/299) [`b68e3a4`](https://github.com/MoonshotAI/kimi-code-app/commit/b68e3a450f8d6d67a3fb7d8a8f53a647970d682f) - 优化队列交互。

- [#215](https://github.com/MoonshotAI/kimi-code-app/pull/215) [`f0a7f5a`](https://github.com/MoonshotAI/kimi-code-app/commit/f0a7f5a0d97ebcd332977f86f43c3b2bb4dbf112) - 登录入口新增 kimi.com / kimi.ai 两种 OAuth 登录选项，软件更新与帮助链接的站点随当前登录切换。

- [#288](https://github.com/MoonshotAI/kimi-code-app/pull/288) [`9168642`](https://github.com/MoonshotAI/kimi-code-app/commit/9168642f59978ba13091c51dd11cebb7eed6a0c8) - 修复其他客户端归档会话后，会话列表需要刷新才会移除该会话的问题。

- [#271](https://github.com/MoonshotAI/kimi-code-app/pull/271) [`198881a`](https://github.com/MoonshotAI/kimi-code-app/commit/198881a4299c5dff67d0794a50626fd6c2f09c7f) - 会话右键菜单底部的时间标注为「最后更新」，并收紧了该行间距。

- [#294](https://github.com/MoonshotAI/kimi-code-app/pull/294) [`ce32c1a`](https://github.com/MoonshotAI/kimi-code-app/commit/ce32c1a239a765395afac1412d15dae997ce4d2d) - 修复侧栏「会话」「置顶」标题右侧按钮与会话条目右侧按钮不对齐的问题。

- [#274](https://github.com/MoonshotAI/kimi-code-app/pull/274) [`bb4cb0b`](https://github.com/MoonshotAI/kimi-code-app/commit/bb4cb0b5bdc85533c19ffeb11f10ad493ebd55e9) - 删掉 skill 激活消息上的「已激活技能」卡片。

- [#274](https://github.com/MoonshotAI/kimi-code-app/pull/274) [`bb4cb0b`](https://github.com/MoonshotAI/kimi-code-app/commit/bb4cb0b5bdc85533c19ffeb11f10ad493ebd55e9) - 修复 skill 激活的消息无法撤销重发的问题。

- [#293](https://github.com/MoonshotAI/kimi-code-app/pull/293) [`d92d68b`](https://github.com/MoonshotAI/kimi-code-app/commit/d92d68b3304994196820dc253ba3b68b4e7698db) - 收紧左下角用户菜单及其子菜单的行高与间距，密度与其他菜单一致。

- [#291](https://github.com/MoonshotAI/kimi-code-app/pull/291) [`2556a22`](https://github.com/MoonshotAI/kimi-code-app/commit/2556a223e6e7fda4f4ee94d0388ee5ca409cbbe3) - 等待后台任务的工具调用现在有专属展示，已完成的任务、等待超时和仍在运行的任务数一目了然。

## 0.0.19

### Patch Changes

- [#260](https://github.com/MoonshotAI/kimi-code-app/pull/260) [`824dca3`](https://github.com/MoonshotAI/kimi-code-app/commit/824dca3db83edbd0c81fddd1515a90ddb838cf7c) - 子代理详情面板不再折叠工作过程，并移除回合结尾的时间栏。

- [#265](https://github.com/MoonshotAI/kimi-code-app/pull/265) [`d96494d`](https://github.com/MoonshotAI/kimi-code-app/commit/d96494db0602378cb5f9032c8e1e1230dc06817a) - 设置页新增「实验室」，内含「多标签页侧边栏」开关（默认关闭），开启后侧边栏显示「进行中 / 已完成 / 工作空间」标签页。

## 0.0.18

### Patch Changes

- [#226](https://github.com/MoonshotAI/kimi-code-app/pull/226) [`dfa3d31`](https://github.com/MoonshotAI/kimi-code-app/commit/dfa3d317599aff0d6bcf2cabcc1aae4baac55793) - @ 提及的文件、文件夹和技能显示为带图标的胶囊，输入框和消息气泡中一致；单技能提及发送时直接激活对应技能。

- [#256](https://github.com/MoonshotAI/kimi-code-app/pull/256) [`a7501ef`](https://github.com/MoonshotAI/kimi-code-app/commit/a7501ef6c2e1bed7f4b2b928abf7cba813cf9a22) - 子 Agent 面板更名为「后台 Agent」。

- [#253](https://github.com/MoonshotAI/kimi-code-app/pull/253) [`c81b815`](https://github.com/MoonshotAI/kimi-code-app/commit/c81b8154c23890171d2c992289c2e40a7d40a51c) - 修复 Windows 上"打开方式"菜单点击 Terminal 没有反应的问题。

- [#239](https://github.com/MoonshotAI/kimi-code-app/pull/239) [`a43de83`](https://github.com/MoonshotAI/kimi-code-app/commit/a43de83237935b82fc25adf717de9f0495ab4062) - 修复消息中 YAML frontmatter 被渲染成巨型标题的问题。

- [#250](https://github.com/MoonshotAI/kimi-code-app/pull/250) [`a031f9c`](https://github.com/MoonshotAI/kimi-code-app/commit/a031f9c1e8b35408e918fd307476d41e35ccae36) - 修复消息中 (c)、(tm)、-- 等普通文本被渲染成 ©、™、破折号等符号的问题。

- [#226](https://github.com/MoonshotAI/kimi-code-app/pull/226) [`dfa3d31`](https://github.com/MoonshotAI/kimi-code-app/commit/dfa3d317599aff0d6bcf2cabcc1aae4baac55793) - @ 提及的文件、文件夹和技能在悬停时显示详情气泡：文件和文件夹展示完整路径，技能展示描述并可直接打开技能文件；消息中的技能和文件提及现在可以点击打开；过长的文件名会中间省略显示；悬停时会检测目标文件是否仍存在，已被删除的会以删除线标出。

- [#243](https://github.com/MoonshotAI/kimi-code-app/pull/243) [`59cd03b`](https://github.com/MoonshotAI/kimi-code-app/commit/59cd03bdee368a961542272dedfba416870beeb1) - 修复任务详情面板长标题把状态标签、复制按钮和关闭按钮挤出可视区的问题：标题超长时省略号截断，悬停可查看完整标题。

- [#259](https://github.com/MoonshotAI/kimi-code-app/pull/259) [`d74636c`](https://github.com/MoonshotAI/kimi-code-app/commit/d74636c5edbef3d32572bc0e839113f64582023c) - 修复复制的文件夹粘贴进输入框会报错的问题。

- [#240](https://github.com/MoonshotAI/kimi-code-app/pull/240) [`b90b406`](https://github.com/MoonshotAI/kimi-code-app/commit/b90b406185b416eacf0213ff7e6d26476156a119) - 降低动画功耗：Rive 吉祥物与首页涂鸦在页面隐藏或滚出视口时暂停渲染循环；running 状态圆点的脉冲改为合成器动画；系统开启「减弱动态效果」时无限动画播放一次即停止，不再永久空转。

- [#245](https://github.com/MoonshotAI/kimi-code-app/pull/245) [`1e8983d`](https://github.com/MoonshotAI/kimi-code-app/commit/1e8983ddc0ea407988a044c7cc7f26dab7015c46) - 审批卡的反馈输入框随内容自动增高，写较长的驳回理由更方便。

- [#237](https://github.com/MoonshotAI/kimi-code-app/pull/237) [`8a4c4bc`](https://github.com/MoonshotAI/kimi-code-app/commit/8a4c4bcf12f50eebad4a86274aad043b4192cc42) - 搜索面板支持搜索工作区，点击工作区或会话结果后侧边栏会展开并滚动置顶定位到对应位置。

- [#221](https://github.com/MoonshotAI/kimi-code-app/pull/221) [`1fb57f0`](https://github.com/MoonshotAI/kimi-code-app/commit/1fb57f0ee3c424675d8768dcc70e56f5c953cd9f) - 新增会话批量管理页面。

- [#221](https://github.com/MoonshotAI/kimi-code-app/pull/221) [`1fb57f0`](https://github.com/MoonshotAI/kimi-code-app/commit/1fb57f0ee3c424675d8768dcc70e56f5c953cd9f) - 侧边栏显示「进行中 / 已完成 / 工作空间」标签，可以标记你已完成的任务。

- [#254](https://github.com/MoonshotAI/kimi-code-app/pull/254) [`29ce233`](https://github.com/MoonshotAI/kimi-code-app/commit/29ce233ce1fdbfaa4c81cb8b4d89e1204cd68c71) - 修复手动停止回答后，重启客户端时空回复下方仍显示完成时间的问题。

- [#256](https://github.com/MoonshotAI/kimi-code-app/pull/256) [`a7501ef`](https://github.com/MoonshotAI/kimi-code-app/commit/a7501ef6c2e1bed7f4b2b928abf7cba813cf9a22) - 修复后台子 Agent 任务刚开始运行时无法取消的问题。

- [#256](https://github.com/MoonshotAI/kimi-code-app/pull/256) [`a7501ef`](https://github.com/MoonshotAI/kimi-code-app/commit/a7501ef6c2e1bed7f4b2b928abf7cba813cf9a22) - 修复前台子代理误入子 Agent 面板导致数量不对、完成后仍显示运行中且无法停止的问题。

- [#243](https://github.com/MoonshotAI/kimi-code-app/pull/243) [`59cd03b`](https://github.com/MoonshotAI/kimi-code-app/commit/59cd03bdee368a961542272dedfba416870beeb1) - 任务详情面板的两个复制图标合并为单个按钮加下拉菜单（复制命令 / 复制输出 / 复制全部），支持键盘操作与触屏尺寸。

- [#256](https://github.com/MoonshotAI/kimi-code-app/pull/256) [`a7501ef`](https://github.com/MoonshotAI/kimi-code-app/commit/a7501ef6c2e1bed7f4b2b928abf7cba813cf9a22) - 修复被取消或异常结束的后台任务误显示为已完成的问题。

- [#247](https://github.com/MoonshotAI/kimi-code-app/pull/247) [`eab2517`](https://github.com/MoonshotAI/kimi-code-app/commit/eab251726b2eed8c5a7a5e1ffd0567abcef1cd76) - 更新弹窗的下载进度从进度条改为在按钮上实时显示，标题保持「发现新版本」不变。

- [#242](https://github.com/MoonshotAI/kimi-code-app/pull/242) [`3421273`](https://github.com/MoonshotAI/kimi-code-app/commit/3421273c044918282dddfe7784a0dab4bec72aba) - 浏览器标签页标题默认显示当前工作区目录名，启动时加 `--web-title` 可自定义，方便区分多台机器的实例。

- [#248](https://github.com/MoonshotAI/kimi-code-app/pull/248) [`edab01d`](https://github.com/MoonshotAI/kimi-code-app/commit/edab01da9d4a5d3571c22d85b2069a626164c040) - 修复 Mac 上输入框里按 Ctrl+K 被会话搜索弹窗抢走、无法删除到行尾的问题。

## 0.0.17

### Patch Changes

- [#229](https://github.com/MoonshotAI/kimi-code-app/pull/229) [`fb090fa`](https://github.com/MoonshotAI/kimi-code-app/commit/fb090fa9a755cc9bf8993c067f898082c8d673fd) - AI 回复下方的时间改为显示消息时间，不再显示工作时长。

- [#211](https://github.com/MoonshotAI/kimi-code-app/pull/211) [`51f725f`](https://github.com/MoonshotAI/kimi-code-app/commit/51f725fdef815059ddd868dd661a79ba144f3c40) - 新增实验性的自动生成会话标题功能

- [#218](https://github.com/MoonshotAI/kimi-code-app/pull/218) [`b85fdf3`](https://github.com/MoonshotAI/kimi-code-app/commit/b85fdf35df759dfda2d90db1a6c8fdf87c406745) - 斜杠命令和 @ 文件引用菜单更换新样式：斜杠命令菜单中匹配的片段会加粗高亮；两个菜单的长列表滚动时都有渐隐效果和可拖动的悬浮滚动条。

- [#209](https://github.com/MoonshotAI/kimi-code-app/pull/209) [`dda9935`](https://github.com/MoonshotAI/kimi-code-app/commit/dda9935db80963b380c2a7ec1e5bd6dac63cb62d) - 后台 Bash 面板支持按状态筛选，点击任务可在右侧查看命令与输出。

- [#230](https://github.com/MoonshotAI/kimi-code-app/pull/230) [`ce891bb`](https://github.com/MoonshotAI/kimi-code-app/commit/ce891bb015ad8d82b791e2022d24b3c56ecf5591) - 修复斜杠命令面板在切换会话或输入框失焦后仍然显示的问题。

- [#220](https://github.com/MoonshotAI/kimi-code-app/pull/220) [`c2d2bc3`](https://github.com/MoonshotAI/kimi-code-app/commit/c2d2bc36a2320ac4a00cab60cf04c9a88c4cd954) - 聊天输入框的撤销/重做现在按会话独立保留，切换会话不会丢失。

- [#219](https://github.com/MoonshotAI/kimi-code-app/pull/219) [`a7f0cc9`](https://github.com/MoonshotAI/kimi-code-app/commit/a7f0cc943c528bdf0067597767c8a15ac4221bc8) - 删除模式菜单：计划与目标改为输入区左侧的互斥模式 pill（/plan、/goal 启用，× 退出），Swarm 拆分为独立的工具栏开关。

- [#209](https://github.com/MoonshotAI/kimi-code-app/pull/209) [`dda9935`](https://github.com/MoonshotAI/kimi-code-app/commit/dda9935db80963b380c2a7ec1e5bd6dac63cb62d) - 输入框上方的工作状态胶囊更换为无边框圆角的新样式。

- [#235](https://github.com/MoonshotAI/kimi-code-app/pull/235) [`af7ed8f`](https://github.com/MoonshotAI/kimi-code-app/commit/af7ed8fa03278bbe2f988732b3195649e7a6f2bc) - 插件设置页的浏览器扩展安装提示收为一行，商店入口改为按钮。

- [#222](https://github.com/MoonshotAI/kimi-code-app/pull/222) [`db79803`](https://github.com/MoonshotAI/kimi-code-app/commit/db79803a9c9c0f1cb38c3c88d61612d616ffe365) - 修复行内代码中的 `$` 内容被误渲染为数学公式的问题。

- [#213](https://github.com/MoonshotAI/kimi-code-app/pull/213) [`db76891`](https://github.com/MoonshotAI/kimi-code-app/commit/db7689160bb4eb9edc823372f82b9f576dfc8aa6) - 修复子智能体模型选择列表最后一个模型时思考强度选不到的问题。

- [#223](https://github.com/MoonshotAI/kimi-code-app/pull/223) [`da12e2a`](https://github.com/MoonshotAI/kimi-code-app/commit/da12e2a9d69bd7e87b72537378ee03b7f0b1d699) - 修复复制历史很长的会话时 fork 操作总是超时失败的问题。

- [#219](https://github.com/MoonshotAI/kimi-code-app/pull/219) [`a7f0cc9`](https://github.com/MoonshotAI/kimi-code-app/commit/a7f0cc943c528bdf0067597767c8a15ac4221bc8) - 在斜杠菜单中选择「/goal」会立即在输入框中启用目标标记（可撤销），输入内容后发送即创建目标，不再要求先在命令后补全目标文本。

- [#209](https://github.com/MoonshotAI/kimi-code-app/pull/209) [`dda9935`](https://github.com/MoonshotAI/kimi-code-app/commit/dda9935db80963b380c2a7ec1e5bd6dac63cb62d) - 目标面板的目标与已运行时间移到头部展示，操作改为图标按钮。

- [#233](https://github.com/MoonshotAI/kimi-code-app/pull/233) [`a52cdbc`](https://github.com/MoonshotAI/kimi-code-app/commit/a52cdbcfbab8ba3d9a3f3936671e1d21de95548c) - 修复链接后紧跟中文时中文被错误并入链接、点击后打不开的问题。

- [#219](https://github.com/MoonshotAI/kimi-code-app/pull/219) [`a7f0cc9`](https://github.com/MoonshotAI/kimi-code-app/commit/a7f0cc943c528bdf0067597767c8a15ac4221bc8) - 调整计划模式的启用时机：开启后先作为输入框内的「计划」标记（可随时撤销），发送消息时才真正生效，与目标模式的行为保持一致。

- [#219](https://github.com/MoonshotAI/kimi-code-app/pull/219) [`a7f0cc9`](https://github.com/MoonshotAI/kimi-code-app/commit/a7f0cc943c528bdf0067597767c8a15ac4221bc8) - 新增计划查看面板：点击工作栏的计划条目即可查看完整计划、评审结果与反馈。

- [#217](https://github.com/MoonshotAI/kimi-code-app/pull/217) [`330ab27`](https://github.com/MoonshotAI/kimi-code-app/commit/330ab2725f9c33de4bcab2dc828bf4aa3e26fe68) - 设置新增「插件」页：内置能力（Kimi Computer Use、Kimi WebBridge）带实时安装进度；官方与第三方插件市场支持安装/更新、启用/禁用与移除；支持从 zip 链接、GitHub 仓库或本地路径直接安装自定义插件；本地装载的插件也会在「已安装」区单独展示。

- [#217](https://github.com/MoonshotAI/kimi-code-app/pull/217) [`330ab27`](https://github.com/MoonshotAI/kimi-code-app/commit/330ab2725f9c33de4bcab2dc828bf4aa3e26fe68) - 修复插件设置页已安装的插件偶尔闪现"安装"按钮的问题。

- [#216](https://github.com/MoonshotAI/kimi-code-app/pull/216) [`09bbd11`](https://github.com/MoonshotAI/kimi-code-app/commit/09bbd11f79f0b33285b6cc3bbcbdfb86b6cc5b82) - 导出会话增加明确的完成反馈(web 端为顶部居中提示,与归档样式一致;桌面端以系统保存对话框为确认),并为会话过大导致的导出失败补充明确的提示。

- [#218](https://github.com/MoonshotAI/kimi-code-app/pull/218) [`b85fdf3`](https://github.com/MoonshotAI/kimi-code-app/commit/b85fdf35df759dfda2d90db1a6c8fdf87c406745) - 斜杠命令支持模糊搜索：输入描述文字、拼音或拼音首字母都能找到命令。

- [#209](https://github.com/MoonshotAI/kimi-code-app/pull/209) [`dda9935`](https://github.com/MoonshotAI/kimi-code-app/commit/dda9935db80963b380c2a7ec1e5bd6dac63cb62d) - 子 Agent 面板改为卡片网格布局，支持按状态过滤，默认展示进行中与最近完成的任务。

- [#227](https://github.com/MoonshotAI/kimi-code-app/pull/227) [`acc0738`](https://github.com/MoonshotAI/kimi-code-app/commit/acc07381f3a1d3947aa1b8e28701e708cd83b2c0) - 修复终端输出较多时最后一行被挤出可视区域的问题。

- [#227](https://github.com/MoonshotAI/kimi-code-app/pull/227) [`acc0738`](https://github.com/MoonshotAI/kimi-code-app/commit/acc07381f3a1d3947aa1b8e28701e708cd83b2c0) - 修复终端面板里输出的链接无法点击打开的问题。

- [#223](https://github.com/MoonshotAI/kimi-code-app/pull/223) [`da12e2a`](https://github.com/MoonshotAI/kimi-code-app/commit/da12e2a9d69bd7e87b72537378ee03b7f0b1d699) - 修复请求服务器超时被误报为“无法连接到 Kimi 服务器”的问题。

- [#209](https://github.com/MoonshotAI/kimi-code-app/pull/209) [`dda9935`](https://github.com/MoonshotAI/kimi-code-app/commit/dda9935db80963b380c2a7ec1e5bd6dac63cb62d) - 待办面板改为磨砂卡片样式，新增「当前进度」完成计数。

- [#225](https://github.com/MoonshotAI/kimi-code-app/pull/225) [`72585bf`](https://github.com/MoonshotAI/kimi-code-app/commit/72585bf09d31b8ca66a34ca093df6b91a87d1aca) - 用户菜单及套餐用量浮层的字号和行高调大了一档。

- [#225](https://github.com/MoonshotAI/kimi-code-app/pull/225) [`72585bf`](https://github.com/MoonshotAI/kimi-code-app/commit/72585bf09d31b8ca66a34ca093df6b91a87d1aca) - 用户菜单的「升级」更名为「会员升级」，套餐用量的百分比增加「已使用」标注。

## 0.0.16

### Patch Changes

- [#204](https://github.com/MoonshotAI/kimi-code-app/pull/204) [`c5440b8`](https://github.com/MoonshotAI/kimi-code-app/commit/c5440b863d02f99457f48520c16c609eae73f12b) - 减少长会话中 AI 流式输出时的界面卡顿。

- [#192](https://github.com/MoonshotAI/kimi-code-app/pull/192) [`5a0c0ef`](https://github.com/MoonshotAI/kimi-code-app/commit/5a0c0ef746638f5112573cb9bcdb173580fbb762) - 为没有文字说明的图标按钮补充悬停提示。

- [#200](https://github.com/MoonshotAI/kimi-code-app/pull/200) [`d8790b9`](https://github.com/MoonshotAI/kimi-code-app/commit/d8790b9bc225ab89d8419f45619a8f0449eb2067) - 全屏图片预览四周增加留白，图片不再顶到屏幕边缘。

- [#200](https://github.com/MoonshotAI/kimi-code-app/pull/200) [`d8790b9`](https://github.com/MoonshotAI/kimi-code-app/commit/d8790b9bc225ab89d8419f45619a8f0449eb2067) - 统一图片和视频全屏预览的样式：共用同一个视口右上角的圆形关闭按钮和相同的背景遮罩。

- [#194](https://github.com/MoonshotAI/kimi-code-app/pull/194) [`863da83`](https://github.com/MoonshotAI/kimi-code-app/commit/863da8345795b2fbfd4067a6336e8389362c9173) - 加宽侧边栏可拖拽的最小宽度。

- [#212](https://github.com/MoonshotAI/kimi-code-app/pull/212) [`4707ee6`](https://github.com/MoonshotAI/kimi-code-app/commit/4707ee6c77737f44cd0059b52aff2082f25e264d) - 修复会话内新建 PR 后，会话列表上的 PR 标记不刷新的问题。

- [#212](https://github.com/MoonshotAI/kimi-code-app/pull/212) [`4707ee6`](https://github.com/MoonshotAI/kimi-code-app/commit/4707ee6c77737f44cd0059b52aff2082f25e264d) - 会话列表的 PR 标记改为带背景的小标签样式。

- [#201](https://github.com/MoonshotAI/kimi-code-app/pull/201) [`aa78dac`](https://github.com/MoonshotAI/kimi-code-app/commit/aa78dac9903514f06477cbb0fc5275946d274e44) - 优化侧边栏 session 状态和排序逻辑。

- [#200](https://github.com/MoonshotAI/kimi-code-app/pull/200) [`d8790b9`](https://github.com/MoonshotAI/kimi-code-app/commit/d8790b9bc225ab89d8419f45619a8f0449eb2067) - 查看图片或视频的工具结果现在点击后全屏预览，图片支持缩放。

- [#202](https://github.com/MoonshotAI/kimi-code-app/pull/202) [`2b72850`](https://github.com/MoonshotAI/kimi-code-app/commit/2b728505b03ef293ac052d2e6d5e9fea36c253fb) - 减少窗口长时间运行后的内存和 CPU 占用。

- [#203](https://github.com/MoonshotAI/kimi-code-app/pull/203) [`61ba25b`](https://github.com/MoonshotAI/kimi-code-app/commit/61ba25b278ac7ff7af9808e275749b0276915188) - 减少长会话使用过程中的内存占用和卡顿。

- [#210](https://github.com/MoonshotAI/kimi-code-app/pull/210) [`852d2cc`](https://github.com/MoonshotAI/kimi-code-app/commit/852d2ccb22c46a7d259f05411a2700677996145d) - 按工作区分组视图新增「按最近活动」排序选项，在视图选项菜单中切换；新增工作区默认排到最上面。

## 0.0.15

### Patch Changes

- [#169](https://github.com/MoonshotAI/kimi-code-app/pull/169) [`6fc20c6`](https://github.com/MoonshotAI/kimi-code-app/commit/6fc20c68dd5b47d5ad0c5f3f06b5a15641faa289) - 优化归档会话的交互：归档后列表会自动补上后面的会话。

- [#180](https://github.com/MoonshotAI/kimi-code-app/pull/180) [`db6b8ce`](https://github.com/MoonshotAI/kimi-code-app/commit/db6b8ce1e567a270e0ece15d90642c143ec7be27) - 修复可用模型较多时模型切换菜单超出屏幕、底部选项不可见的问题。

- [#179](https://github.com/MoonshotAI/kimi-code-app/pull/179) [`3568f49`](https://github.com/MoonshotAI/kimi-code-app/commit/3568f49671a02f48f0b7ab13f5e439a3bb38be10) - 支持把文件夹拖入输入框直接插入文件夹路径。

- [#178](https://github.com/MoonshotAI/kimi-code-app/pull/178) [`897e5fd`](https://github.com/MoonshotAI/kimi-code-app/commit/897e5fd24d87de74980c8bea7dd29816feb3f293) - 模型请求失败导致对话中断时，会话内会常驻显示失败卡片并可一键继续。

- [#174](https://github.com/MoonshotAI/kimi-code-app/pull/174) [`1a4dc18`](https://github.com/MoonshotAI/kimi-code-app/commit/1a4dc18ce750cdc4d10e184ee84f9b0c1d3b2a1d) - 修复聊天中代码块没有使用等宽字体、字号偏小的问题。

- [#174](https://github.com/MoonshotAI/kimi-code-app/pull/174) [`1a4dc18`](https://github.com/MoonshotAI/kimi-code-app/commit/1a4dc18ce750cdc4d10e184ee84f9b0c1d3b2a1d) - 修复新会话还未发送消息时 @ 文件提及搜索不到文件的问题。

- [#170](https://github.com/MoonshotAI/kimi-code-app/pull/170) [`413f7ad`](https://github.com/MoonshotAI/kimi-code-app/commit/413f7ad5baf29e74f8bda55b305b7aa450d27437) - 修复侧边栏开合或流式消息结束折叠时「最新消息」按钮误出现的问题。

- [#165](https://github.com/MoonshotAI/kimi-code-app/pull/165) [`739b693`](https://github.com/MoonshotAI/kimi-code-app/commit/739b693110625af5b1703d61c95a6a60612a9953) - 「内部测试」标识从设置菜单里移到侧边栏底部用户名旁边。

- [#172](https://github.com/MoonshotAI/kimi-code-app/pull/172) [`ec74eab`](https://github.com/MoonshotAI/kimi-code-app/commit/ec74eab9ce8c66ec93b350a6abff5f2b9aa2cd6d) - 支持预览工作区外的文件，聊天中提到的任意文件路径都可以点开查看。

- [#168](https://github.com/MoonshotAI/kimi-code-app/pull/168) [`852e549`](https://github.com/MoonshotAI/kimi-code-app/commit/852e5493f5a47b257ebcd605557c0f2e5df487bc) - 会话列表的置顶和归档按钮增加了悬停文字提示。

- [#171](https://github.com/MoonshotAI/kimi-code-app/pull/171) [`d17567e`](https://github.com/MoonshotAI/kimi-code-app/commit/d17567e6217d5da9e8b056f4349646eff4feab1e) - 优化设置页排版。

- [#178](https://github.com/MoonshotAI/kimi-code-app/pull/178) [`897e5fd`](https://github.com/MoonshotAI/kimi-code-app/commit/897e5fd24d87de74980c8bea7dd29816feb3f293) - 侧栏会话的异常标记改为仅在上一轮对话失败时显示，手动终止的会话不再被标记。

- [#183](https://github.com/MoonshotAI/kimi-code-app/pull/183) [`277af5d`](https://github.com/MoonshotAI/kimi-code-app/commit/277af5dd9b07cbab156c913bf0ac06390d4027d1) - 侧栏会话列表新增平铺视图

- [#176](https://github.com/MoonshotAI/kimi-code-app/pull/176) [`8ef34c2`](https://github.com/MoonshotAI/kimi-code-app/commit/8ef34c22aeb0eff374433a9ad5c713992a312f09) - 侧栏滚动时置顶会话和「工作区」标题保持固定，置顶区可折叠。

- [#191](https://github.com/MoonshotAI/kimi-code-app/pull/191) [`4c1f7b5`](https://github.com/MoonshotAI/kimi-code-app/commit/4c1f7b58d88b6754be2c4fb58088f1498a4d91b2) - 修复 Skill 命令与附件一起发送时附件被静默丢弃的问题。

- [#182](https://github.com/MoonshotAI/kimi-code-app/pull/182) [`bfac055`](https://github.com/MoonshotAI/kimi-code-app/commit/bfac05512857f005d8506159eda2a891f94a4865) - 修复新会话页面手动切换思考档位后，发送技能（/skill）命令会使档位被重置回模型默认的问题。

- [#177](https://github.com/MoonshotAI/kimi-code-app/pull/177) [`9c23755`](https://github.com/MoonshotAI/kimi-code-app/commit/9c2375588a8dae75cebe0bb07436efa7b2a541b9) - 修复重命名会话时拼音输入中按回车会直接提交、按 Esc 会直接退出的问题。

- [#188](https://github.com/MoonshotAI/kimi-code-app/pull/188) [`9d67d3c`](https://github.com/MoonshotAI/kimi-code-app/commit/9d67d3ce150d43cbefde4b2f25b1f3829979edf1) - 子代理任务现在显示它使用的模型和思考档位。

- [#177](https://github.com/MoonshotAI/kimi-code-app/pull/177) [`9c23755`](https://github.com/MoonshotAI/kimi-code-app/commit/9c2375588a8dae75cebe0bb07436efa7b2a541b9) - 修复重命名会话或工作区时无法拖选文字、拖动会移动整个列表项的问题。

- [#190](https://github.com/MoonshotAI/kimi-code-app/pull/190) [`4c5d9e7`](https://github.com/MoonshotAI/kimi-code-app/commit/4c5d9e7777a27d6947017aa3e0b7a5f7193dc063) - 修复文件变更总结卡片"收起"按钮箭头方向错误的问题。

- [#178](https://github.com/MoonshotAI/kimi-code-app/pull/178) [`897e5fd`](https://github.com/MoonshotAI/kimi-code-app/commit/897e5fd24d87de74980c8bea7dd29816feb3f293) - 模型请求失败后的自动重试期间，工作状态会显示重试进度（第几次/共几次），不再像无响应。

- [#175](https://github.com/MoonshotAI/kimi-code-app/pull/175) [`d445135`](https://github.com/MoonshotAI/kimi-code-app/commit/d44513598868420cdfd8bde5d630cd5368ee082a) - 修复 Windows 上同一个文件夹因路径写法不同（大小写、斜杠方向）被显示成多个工作区的问题。

- [#181](https://github.com/MoonshotAI/kimi-code-app/pull/181) [`278c8f4`](https://github.com/MoonshotAI/kimi-code-app/commit/278c8f4d72d984e26bc9cc34f92b36aab5be4b4e) - 修复计划审批弹窗展开后，后台任务和待办入口被顶到窗口顶部的问题。

- [#175](https://github.com/MoonshotAI/kimi-code-app/pull/175) [`d445135`](https://github.com/MoonshotAI/kimi-code-app/commit/d44513598868420cdfd8bde5d630cd5368ee082a) - 添加工作区对话框不再显示 git 标记，移动端工作区列表不再显示分支。

## 0.0.14

### Patch Changes

- [#164](https://github.com/MoonshotAI/kimi-code-app/pull/164) [`5272a23`](https://github.com/MoonshotAI/kimi-code-app/commit/5272a23f59bc23bef87b2448e212c16e18121b5f) - 优化会话归档交互。

- [#156](https://github.com/MoonshotAI/kimi-code-app/pull/156) [`6e1c9da`](https://github.com/MoonshotAI/kimi-code-app/commit/6e1c9da713b52d7ed862c821096412fa204418fa) - 网页授权登录完成后，支持一键唤起桌面端。

- [#158](https://github.com/MoonshotAI/kimi-code-app/pull/158) [`54cf068`](https://github.com/MoonshotAI/kimi-code-app/commit/54cf068ebaf7213799c0e40a64c8ccecd3b14c5d) - 修复复制会话 ID 后菜单项出现对号图标的问题。

- [#160](https://github.com/MoonshotAI/kimi-code-app/pull/160) [`0c9a22f`](https://github.com/MoonshotAI/kimi-code-app/commit/0c9a22fd1bdf3d55198ad7ec7a3b2419fb3d62c0) - 修复部分代码块行号与代码正文重叠的问题。

- [#158](https://github.com/MoonshotAI/kimi-code-app/pull/158) [`54cf068`](https://github.com/MoonshotAI/kimi-code-app/commit/54cf068ebaf7213799c0e40a64c8ccecd3b14c5d) - 修复"最新消息"按钮悬停时背景变半透明的问题。

- [#162](https://github.com/MoonshotAI/kimi-code-app/pull/162) [`12cc99c`](https://github.com/MoonshotAI/kimi-code-app/commit/12cc99ca74822e81225473ca627076aef986daf0) - 优化登录交互

- [#157](https://github.com/MoonshotAI/kimi-code-app/pull/157) [`ac9b35c`](https://github.com/MoonshotAI/kimi-code-app/commit/ac9b35c52c47baaba44e30ef79dacbffc77687a2) - 设置页和移动端设置里显示登录用户的头像、昵称和用户等级。

- [#155](https://github.com/MoonshotAI/kimi-code-app/pull/155) [`dd04056`](https://github.com/MoonshotAI/kimi-code-app/commit/dd04056d5dc73f43a225e1108677873cf2dced71) - 修复流式输出中代码块的语法高亮偶尔丢失、定居后仍显示为纯文本的问题。

- [#152](https://github.com/MoonshotAI/kimi-code-app/pull/152) [`223323b`](https://github.com/MoonshotAI/kimi-code-app/commit/223323b5189f7e13db17c5855ac0e32f3cd9edc8) - 修复输入单独的 @ 时文件菜单误显示"无匹配"的问题。

- [#164](https://github.com/MoonshotAI/kimi-code-app/pull/164) [`5272a23`](https://github.com/MoonshotAI/kimi-code-app/commit/5272a23f59bc23bef87b2448e212c16e18121b5f) - 移除工作区按时间排序逻辑。

- [#163](https://github.com/MoonshotAI/kimi-code-app/pull/163) [`9e17cee`](https://github.com/MoonshotAI/kimi-code-app/commit/9e17cee9dc5ede5f057a277a6e715297d7f65620) - 设置页新增子智能体模型与思考强度设置（实验性，需在服务端开启 secondary-model 实验开关后显示）。

- [#153](https://github.com/MoonshotAI/kimi-code-app/pull/153) [`8abde94`](https://github.com/MoonshotAI/kimi-code-app/commit/8abde94b2bbd690400ccc0dffa99a88f77f3ea8e) - 优化 session 展开收起交互。

- [#157](https://github.com/MoonshotAI/kimi-code-app/pull/157) [`ac9b35c`](https://github.com/MoonshotAI/kimi-code-app/commit/ac9b35c52c47baaba44e30ef79dacbffc77687a2) - 侧栏左下角新增用户区：显示登录头像与昵称，菜单内含套餐用量、主题与语言切换、设置和退出登录，退出登录增加二次确认。

- [#161](https://github.com/MoonshotAI/kimi-code-app/pull/161) [`4212517`](https://github.com/MoonshotAI/kimi-code-app/commit/42125177b9b3d61600078eada84862cb99441347) - 修复打开终端时右侧消息大纲遮挡终端面板的问题。

## 0.0.13

### Patch Changes

- [#150](https://github.com/MoonshotAI/kimi-code-app/pull/150) [`9e0e486`](https://github.com/MoonshotAI/kimi-code-app/commit/9e0e4863573eadf47a59096888e3285dbd2362f9) - 桌面端现在会读取 shell 环境中的 KIMI_CODE_HOME 等环境变量。

- [#148](https://github.com/MoonshotAI/kimi-code-app/pull/148) [`6720944`](https://github.com/MoonshotAI/kimi-code-app/commit/6720944aeddf174ab680c602aa6c6efea63f836e) - 修复打开已被删除或移动的文件时提示「无法读取这个文件」的问题。

- [#145](https://github.com/MoonshotAI/kimi-code-app/pull/145) [`2aa50b5`](https://github.com/MoonshotAI/kimi-code-app/commit/2aa50b5c094a9e65d7fc1cfee75206a14a0e4693) - 修复使用自定义 OpenAI 兼容服务商的模型时，重新打开会话后长回复变成竖排文字的问题。

- [#109](https://github.com/MoonshotAI/kimi-code-app/pull/109) [`5c22dc9`](https://github.com/MoonshotAI/kimi-code-app/commit/5c22dc91d70f1aac29b098c3c212b7bae7dea349) - 重连后自动同步所有会话的工作状态，避免侧栏“工作中”提示停留。

- [#146](https://github.com/MoonshotAI/kimi-code-app/pull/146) [`a1702a5`](https://github.com/MoonshotAI/kimi-code-app/commit/a1702a54ba96aad09012dfd64636e514cf341648) - 修复调用 skill 会把「已工作」记录拆成两段的问题。

- [#148](https://github.com/MoonshotAI/kimi-code-app/pull/148) [`6720944`](https://github.com/MoonshotAI/kimi-code-app/commit/6720944aeddf174ab680c602aa6c6efea63f836e) - 修复再次点击文件改动卡片里的文件时右侧改动面板无法收起的问题。

- [#148](https://github.com/MoonshotAI/kimi-code-app/pull/148) [`6720944`](https://github.com/MoonshotAI/kimi-code-app/commit/6720944aeddf174ab680c602aa6c6efea63f836e) - 去掉文件改动卡片底部「还有 N 个文件」按钮按下时的压缩效果。

- [#148](https://github.com/MoonshotAI/kimi-code-app/pull/148) [`6720944`](https://github.com/MoonshotAI/kimi-code-app/commit/6720944aeddf174ab680c602aa6c6efea63f836e) - 修复一轮对话末尾文件改动卡片里的文件无法点击打开的问题。

- [#148](https://github.com/MoonshotAI/kimi-code-app/pull/148) [`6720944`](https://github.com/MoonshotAI/kimi-code-app/commit/6720944aeddf174ab680c602aa6c6efea63f836e) - 修复文件改动卡片里文件链接 hover 时下划线过深的问题。

## 0.0.12

### Patch Changes

- [#138](https://github.com/MoonshotAI/kimi-code-app/pull/138) [`1825bec`](https://github.com/MoonshotAI/kimi-code-app/commit/1825bec3ed322da312b51361d605c896c3c0331b) - 会话图标选择器新增聊天气泡、警灯、工具箱等 20 个常用 emoji，均可按中英文关键词搜索。

- [#142](https://github.com/MoonshotAI/kimi-code-app/pull/142) [`28c2780`](https://github.com/MoonshotAI/kimi-code-app/commit/28c2780188a3224573756913ddb68665e9ee3b88) - 附件过多时输入框的附件列表限高滚动：新增附件自动滚动到可见位置，并显示附件总数。

- [#142](https://github.com/MoonshotAI/kimi-code-app/pull/142) [`28c2780`](https://github.com/MoonshotAI/kimi-code-app/commit/28c2780188a3224573756913ddb68665e9ee3b88) - 输入框中的附件支持一键清空。

- [#128](https://github.com/MoonshotAI/kimi-code-app/pull/128) [`949f00f`](https://github.com/MoonshotAI/kimi-code-app/commit/949f00fdb470a44908d27bb5f6c0802b278686f0) - 移除了内置服务器的访问令牌校验，启动时不再可能弹出要求输入服务器密码的对话框。

- [#132](https://github.com/MoonshotAI/kimi-code-app/pull/132) [`9a5e75b`](https://github.com/MoonshotAI/kimi-code-app/commit/9a5e75ba3d54687048e58d8b151a1a04e24cd15a) - 新增内置终端。

- [#142](https://github.com/MoonshotAI/kimi-code-app/pull/142) [`28c2780`](https://github.com/MoonshotAI/kimi-code-app/commit/28c2780188a3224573756913ddb68665e9ee3b88) - 修复附件预览右上角关闭按钮点不动的问题，预览支持按 Esc 关闭。

- [#130](https://github.com/MoonshotAI/kimi-code-app/pull/130) [`170784e`](https://github.com/MoonshotAI/kimi-code-app/commit/170784e30b9b3f829cb1b2ba51be138f889df7b9) - 修复查找栏当前匹配项的高亮描边偏移、不能完整包裹高亮区域的问题。

- [#135](https://github.com/MoonshotAI/kimi-code-app/pull/135) [`266a14d`](https://github.com/MoonshotAI/kimi-code-app/commit/266a14d449e1274a6326fc259eac94426fcbadb2) - 修复排队中的长消息显示为空白气泡的问题。

- [#136](https://github.com/MoonshotAI/kimi-code-app/pull/136) [`7feb33b`](https://github.com/MoonshotAI/kimi-code-app/commit/7feb33b6d4779f588019405697e34964508d0475) - 修复 Windows 任务栏错误显示 Electron 图标和名称的问题。

- [#113](https://github.com/MoonshotAI/kimi-code-app/pull/113) [`10f5f88`](https://github.com/MoonshotAI/kimi-code-app/commit/10f5f88fc4592ddd13592c48eefaea4027cddbdf) - 修复行内数学公式（$…$）无法渲染的问题。

- [#126](https://github.com/MoonshotAI/kimi-code-app/pull/126) [`b05e7a3`](https://github.com/MoonshotAI/kimi-code-app/commit/b05e7a3b3fd5a1e5c73c90c9b39bdcc0fde65fff) - 修复置顶会话行上状态徽章的提示和整行提示会同时弹出的问题。

- [#144](https://github.com/MoonshotAI/kimi-code-app/pull/144) [`7a1fd22`](https://github.com/MoonshotAI/kimi-code-app/commit/7a1fd229fd410ace774921276013a3d4a35ee0d8) - 图片附件预览改为从缩略图位置平滑放大打开，支持滚轮缩放查看细节。

- [#137](https://github.com/MoonshotAI/kimi-code-app/pull/137) [`d434457`](https://github.com/MoonshotAI/kimi-code-app/commit/d434457110402b5a24abd0bb905f5414ba4e6d35) - 修复子 Agent 详情中的操作卡顿、错误跳转、通知及运行状态显示问题。

- [#136](https://github.com/MoonshotAI/kimi-code-app/pull/136) [`7feb33b`](https://github.com/MoonshotAI/kimi-code-app/commit/7feb33b6d4779f588019405697e34964508d0475) - 将托盘菜单入口更名为“打开 Kimi Code”。

- [#127](https://github.com/MoonshotAI/kimi-code-app/pull/127) [`2a60c73`](https://github.com/MoonshotAI/kimi-code-app/commit/2a60c735485d900f7211a8d5a3466e71e0a5414c) - 历史会话中的计划现在会显示完整正文、评审状态、所选方案和反馈。

- [#137](https://github.com/MoonshotAI/kimi-code-app/pull/137) [`d434457`](https://github.com/MoonshotAI/kimi-code-app/commit/d434457110402b5a24abd0bb905f5414ba4e6d35) - 子 Agent 和 Swarm 详情支持按需恢复完整消息流，并减少流式更新时的卡顿。

- [#126](https://github.com/MoonshotAI/kimi-code-app/pull/126) [`b05e7a3`](https://github.com/MoonshotAI/kimi-code-app/commit/b05e7a3b3fd5a1e5c73c90c9b39bdcc0fde65fff) - 修复鼠标悬停在带状态徽章的会话行时标题被遮住一截的问题。

- [#137](https://github.com/MoonshotAI/kimi-code-app/pull/137) [`d434457`](https://github.com/MoonshotAI/kimi-code-app/commit/d434457110402b5a24abd0bb905f5414ba4e6d35) - 修复打开子 Agent 详情面板时页面卡顿的问题。

- [#140](https://github.com/MoonshotAI/kimi-code-app/pull/140) [`484ad78`](https://github.com/MoonshotAI/kimi-code-app/commit/484ad78c83e34aa98035d3b85d903ff41e1965a0) - 重构用量显示逻辑

- [#143](https://github.com/MoonshotAI/kimi-code-app/pull/143) [`57037ca`](https://github.com/MoonshotAI/kimi-code-app/commit/57037cac8bc03b6652ef7a8be97fd3763bc7f71b) - 修复鼠标快速划过对话目录时目录闪烁展开的问题。

- [#101](https://github.com/MoonshotAI/kimi-code-app/pull/101) [`7d96d40`](https://github.com/MoonshotAI/kimi-code-app/commit/7d96d40cfb81cd25f88a0fe4050d9193bc8ff86e) - 对话每轮回复结束后展示本轮修改的文件汇总，可展开查看每个文件的增删行数。

- [#142](https://github.com/MoonshotAI/kimi-code-app/pull/142) [`28c2780`](https://github.com/MoonshotAI/kimi-code-app/commit/28c2780188a3224573756913ddb68665e9ee3b88) - 统一输入框与已发送消息中附件的样式：图片和视频显示为缩略图、文件显示为胶囊，待发送附件列表收进输入框内。

- [#141](https://github.com/MoonshotAI/kimi-code-app/pull/141) [`56a37f6`](https://github.com/MoonshotAI/kimi-code-app/commit/56a37f6e51b63b91232577bb22b6504d74ea7a58) - 统一界面中文件与工具调用数量的数字显示。

- [#139](https://github.com/MoonshotAI/kimi-code-app/pull/139) [`7538b76`](https://github.com/MoonshotAI/kimi-code-app/commit/7538b7627bd1744ef92764b4cfc3ecb996f653b5) - 优化下载更新弹窗

- [`a8eef0e`](https://github.com/MoonshotAI/kimi-code-app/commit/a8eef0eda2f260dc2b2f1e05b7b65ec3bdecd578) - 更新弹窗加宽，更新内容较多时改为在内容区内滚动，不再把弹窗撑得很长。

## 0.0.11

### Patch Changes

- [#112](https://github.com/MoonshotAI/kimi-code-app/pull/112) [`9abb793`](https://github.com/MoonshotAI/kimi-code-app/commit/9abb79383e310d9feb153f378c77a3a30e6f244f) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复其他会话在后台运行任务时，当前会话也跟着变卡的问题。

- [#123](https://github.com/MoonshotAI/kimi-code-app/pull/123) [`8140820`](https://github.com/MoonshotAI/kimi-code-app/commit/8140820d5958044b2b80233da45d948db6814a84) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复 Windows 桌面快捷方式图标显示偏小的问题。

- [#123](https://github.com/MoonshotAI/kimi-code-app/pull/123) [`8140820`](https://github.com/MoonshotAI/kimi-code-app/commit/8140820d5958044b2b80233da45d948db6814a84) Thanks [@liruifengv](https://github.com/liruifengv)! - Windows 桌面端采用与应用界面一致的自定义标题栏和菜单栏。

- [#120](https://github.com/MoonshotAI/kimi-code-app/pull/120) [`15d9f7e`](https://github.com/MoonshotAI/kimi-code-app/commit/15d9f7ef526d7062434eac15390fc01930cccb7e) Thanks [@chengluyu](https://github.com/chengluyu)! - 收紧输入框「权限」与「模式」按钮及下拉菜单的文字排版：按钮与选项名称字号调小，菜单描述字重减轻、行高收紧。

- [#125](https://github.com/MoonshotAI/kimi-code-app/pull/125) [`e64c302`](https://github.com/MoonshotAI/kimi-code-app/commit/e64c3027328bf62f25d79caff5c9620847b6bfb8) Thanks [@liruifengv](https://github.com/liruifengv)! - 助手自我介绍改为 Kimi Code 桌面端身份，回复排版指引适配桌面聊天界面。

- [#118](https://github.com/MoonshotAI/kimi-code-app/pull/118) [`fab5444`](https://github.com/MoonshotAI/kimi-code-app/commit/fab54442863fe3de96875ebe730a2fe2b0d02481) Thanks [@liruifengv](https://github.com/liruifengv)! - 「帮助」菜单新增「性能录制」。

- [#111](https://github.com/MoonshotAI/kimi-code-app/pull/111) [`934f3c8`](https://github.com/MoonshotAI/kimi-code-app/commit/934f3c8a6fc5241b1175dc669f1b014754696b4e) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复新建的空文件在改动面板中被误报为“没有行级改动”的问题。

- [#111](https://github.com/MoonshotAI/kimi-code-app/pull/111) [`934f3c8`](https://github.com/MoonshotAI/kimi-code-app/commit/934f3c8a6fc5241b1175dc669f1b014754696b4e) Thanks [@chengluyu](https://github.com/chengluyu)! - 改动面板的代码差异视图支持语法高亮，代码字号调整为比正文小一号。

- [#111](https://github.com/MoonshotAI/kimi-code-app/pull/111) [`934f3c8`](https://github.com/MoonshotAI/kimi-code-app/commit/934f3c8a6fc5241b1175dc669f1b014754696b4e) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复文件预览的代码字号与改动视图不一致的问题。

- [#111](https://github.com/MoonshotAI/kimi-code-app/pull/111) [`934f3c8`](https://github.com/MoonshotAI/kimi-code-app/commit/934f3c8a6fc5241b1175dc669f1b014754696b4e) Thanks [@chengluyu](https://github.com/chengluyu)! - 文件预览的代码内容支持完整语法高亮，与改动视图一致。

- [#102](https://github.com/MoonshotAI/kimi-code-app/pull/102) [`66a6db6`](https://github.com/MoonshotAI/kimi-code-app/commit/66a6db69bdd205fd0af2d7c1422a027b7276c2ad) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复消息中的待办列表（`- [ ]`）同时显示圆点和复选框的问题。

- [#102](https://github.com/MoonshotAI/kimi-code-app/pull/102) [`66a6db6`](https://github.com/MoonshotAI/kimi-code-app/commit/66a6db69bdd205fd0af2d7c1422a027b7276c2ad) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复关闭毛玻璃侧栏后启动时仍会闪一下毛玻璃的问题。

- [#121](https://github.com/MoonshotAI/kimi-code-app/pull/121) [`51017fe`](https://github.com/MoonshotAI/kimi-code-app/commit/51017fec5f0c6fbf3465dc9c75fc3793923a4c18) Thanks [@chengluyu](https://github.com/chengluyu)! - 所有弹出菜单改为毛玻璃质感。

- [#107](https://github.com/MoonshotAI/kimi-code-app/pull/107) [`7b361d4`](https://github.com/MoonshotAI/kimi-code-app/commit/7b361d427a07fc411cfbe994c7e9968a1b5f0334) Thanks [@liruifengv](https://github.com/liruifengv)! - 输入框内容较多时不再显示右侧滚动条。

- [#122](https://github.com/MoonshotAI/kimi-code-app/pull/122) [`44e36e1`](https://github.com/MoonshotAI/kimi-code-app/commit/44e36e11b0b3b351b1c6a9fce9268e3ff068bfd1) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 不足 1 秒的耗时不再显示 <1s 字样。

- [#129](https://github.com/MoonshotAI/kimi-code-app/pull/129) [`d6b75e6`](https://github.com/MoonshotAI/kimi-code-app/commit/d6b75e6ce63152b290701c6db8424a414428f2be) Thanks [@liruifengv](https://github.com/liruifengv)! - 补充本地化文案。

- [#116](https://github.com/MoonshotAI/kimi-code-app/pull/116) [`41970aa`](https://github.com/MoonshotAI/kimi-code-app/commit/41970aa2276c25f82b1056d40214ed8ee9637ecd) Thanks [@liruifengv](https://github.com/liruifengv)! - 消息发送后的加载动画从月亮换成小蓝，并随阶段显示「请求中…」「工作中…」文案。

- [#114](https://github.com/MoonshotAI/kimi-code-app/pull/114) [`ac59b69`](https://github.com/MoonshotAI/kimi-code-app/commit/ac59b699a0c680682a684142bc149c49c1f9e9c8) Thanks [@chengluyu](https://github.com/chengluyu)! - 文本输入框（搜索框、输入区、重命名等）支持系统原生右键菜单：macOS 上有查找（Look Up）、撤销、重做、剪切、拷贝、粘贴、全选。

- [#129](https://github.com/MoonshotAI/kimi-code-app/pull/129) [`d6b75e6`](https://github.com/MoonshotAI/kimi-code-app/commit/d6b75e6ce63152b290701c6db8424a414428f2be) Thanks [@liruifengv](https://github.com/liruifengv)! - 「新建对话」统一更名为「新建会话」（英文界面为 New Session）。

- [#120](https://github.com/MoonshotAI/kimi-code-app/pull/120) [`15d9f7e`](https://github.com/MoonshotAI/kimi-code-app/commit/15d9f7ef526d7062434eac15390fc01930cccb7e) Thanks [@chengluyu](https://github.com/chengluyu)! - 修正「逐条确认」权限在下拉菜单中颜色偏淡的问题，与其他菜单项颜色一致。

- [#120](https://github.com/MoonshotAI/kimi-code-app/pull/120) [`15d9f7e`](https://github.com/MoonshotAI/kimi-code-app/commit/15d9f7ef526d7062434eac15390fc01930cccb7e) Thanks [@chengluyu](https://github.com/chengluyu)! - 权限模式增加专属图标，逐条确认、自动通过、完全自主在输入框工具栏和下拉菜单中都有对应图标。

- [#115](https://github.com/MoonshotAI/kimi-code-app/pull/115) [`f1179ac`](https://github.com/MoonshotAI/kimi-code-app/commit/f1179acec210d38c1e9d243c98d1ebcba29dc3e5) Thanks [@liruifengv](https://github.com/liruifengv)! - 移除桌面宠物「小蓝」（View 菜单里的 Kimi Pet 开关与桌面浮窗）。

- [#124](https://github.com/MoonshotAI/kimi-code-app/pull/124) [`6e6b539`](https://github.com/MoonshotAI/kimi-code-app/commit/6e6b5391ffb4c6d3016eb861a99171c5d8ab8908) Thanks [@chengluyu](https://github.com/chengluyu)! - 添加附件、置顶和取消置顶按钮恢复旧版图标样式。

- [#104](https://github.com/MoonshotAI/kimi-code-app/pull/104) [`41cc40a`](https://github.com/MoonshotAI/kimi-code-app/commit/41cc40a3b068e4d77e3b114a249f619c0ab81094) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复使用全选快捷键时会同时选中两侧边栏内容的问题。

- [#112](https://github.com/MoonshotAI/kimi-code-app/pull/112) [`9abb793`](https://github.com/MoonshotAI/kimi-code-app/commit/9abb79383e310d9feb153f378c77a3a30e6f244f) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复切换会话时对话界面先闪现顶部消息再滚动到底部的问题。

- [#117](https://github.com/MoonshotAI/kimi-code-app/pull/117) [`d4e51b2`](https://github.com/MoonshotAI/kimi-code-app/commit/d4e51b29319f084205b840f8904e6d6914cb19f3) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复从访达/Dock 启动时读取不到本机终端环境（如 gh、rclone 等命令行工具）的问题。

- [#110](https://github.com/MoonshotAI/kimi-code-app/pull/110) [`c13cef5`](https://github.com/MoonshotAI/kimi-code-app/commit/c13cef5811c368f2b8018484cd38ba2cdb58065a) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复 Windows 重复启动应用时打开多个实例的问题。

- [#112](https://github.com/MoonshotAI/kimi-code-app/pull/112) [`9abb793`](https://github.com/MoonshotAI/kimi-code-app/commit/9abb79383e310d9feb153f378c77a3a30e6f244f) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复长时间运行的会话输出越多越卡的问题。

- [#107](https://github.com/MoonshotAI/kimi-code-app/pull/107) [`7b361d4`](https://github.com/MoonshotAI/kimi-code-app/commit/7b361d427a07fc411cfbe994c7e9968a1b5f0334) Thanks [@liruifengv](https://github.com/liruifengv)! - 开始新会话前的输入框加高到三行。

- [#114](https://github.com/MoonshotAI/kimi-code-app/pull/114) [`ac59b69`](https://github.com/MoonshotAI/kimi-code-app/commit/ac59b699a0c680682a684142bc149c49c1f9e9c8) Thanks [@chengluyu](https://github.com/chengluyu)! - 新增对话内容搜索：按 Cmd+F（macOS）或 Ctrl+F 在对话右上角调出搜索框，显示匹配数量并支持上/下一条跳转定位。

- [#123](https://github.com/MoonshotAI/kimi-code-app/pull/123) [`8140820`](https://github.com/MoonshotAI/kimi-code-app/commit/8140820d5958044b2b80233da45d948db6814a84) Thanks [@liruifengv](https://github.com/liruifengv)! - Windows 标题栏图标随主题切换，并为托盘使用白底品牌图标。

- [#110](https://github.com/MoonshotAI/kimi-code-app/pull/110) [`c13cef5`](https://github.com/MoonshotAI/kimi-code-app/commit/c13cef5811c368f2b8018484cd38ba2cdb58065a) Thanks [@liruifengv](https://github.com/liruifengv)! - Windows 任务栏右键菜单支持新建会话和打开最近工作区。

- [#110](https://github.com/MoonshotAI/kimi-code-app/pull/110) [`c13cef5`](https://github.com/MoonshotAI/kimi-code-app/commit/c13cef5811c368f2b8018484cd38ba2cdb58065a) Thanks [@liruifengv](https://github.com/liruifengv)! - 「用其他应用打开」支持 Windows。

- [#110](https://github.com/MoonshotAI/kimi-code-app/pull/110) [`c13cef5`](https://github.com/MoonshotAI/kimi-code-app/commit/c13cef5811c368f2b8018484cd38ba2cdb58065a) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复 Windows 下的通知功能。

- [#110](https://github.com/MoonshotAI/kimi-code-app/pull/110) [`c13cef5`](https://github.com/MoonshotAI/kimi-code-app/commit/c13cef5811c368f2b8018484cd38ba2cdb58065a) Thanks [@liruifengv](https://github.com/liruifengv)! - 优化 Windows 托盘功能。

## 0.0.10

### Patch Changes

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - 新建文件夹按钮的图标换成 Kimi 动画版：悬停时加号旋转跳动一次。

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - 新建聊天图标换上悬停动画版本：鼠标移入时加号会旋转跳动一次（侧栏与折叠态快捷按钮均生效）。

- [#92](https://github.com/MoonshotAI/kimi-code-app/pull/92) [`4de4c9c`](https://github.com/MoonshotAI/kimi-code-app/commit/4de4c9c0ffe3f46f4dd9859216e66c0851026428) Thanks [@chengluyu](https://github.com/chengluyu)! - 设置里新增应用图标选项，程序坞图标可固定为浅色、深色或跟随系统自动切换。

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - 归档图标换新为 Kimi 设计系统图标。

- [#105](https://github.com/MoonshotAI/kimi-code-app/pull/105) [`a9d175f`](https://github.com/MoonshotAI/kimi-code-app/commit/a9d175fd117eba180bd71217b3a9abe71e4efc5b) Thanks [@chengluyu](https://github.com/chengluyu)! - 会话菜单里的「归档」不再使用红色警示样式，避免误以为归档会删除会话。

- [#87](https://github.com/MoonshotAI/kimi-code-app/pull/87) [`3e9e1c3`](https://github.com/MoonshotAI/kimi-code-app/commit/3e9e1c30ea441be3c0fc4a39009bb5185b0b7030) Thanks [@liruifengv](https://github.com/liruifengv)! - 支持在后台自动下载新版本，下载完成后从侧边栏的更新入口重启即可更新；可在设置 → 高级中开启。

- [#86](https://github.com/MoonshotAI/kimi-code-app/pull/86) [`991b34b`](https://github.com/MoonshotAI/kimi-code-app/commit/991b34bdc5d8532c04f34bac98e7d4e8a27a04ac) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 过长的用户消息默认折叠为渐隐预览，点击可展开或收起。

- [#98](https://github.com/MoonshotAI/kimi-code-app/pull/98) [`9d462ec`](https://github.com/MoonshotAI/kimi-code-app/commit/9d462ecb8bcbbb6f81803c7e7e301f454e686e4c) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 排队中的长消息也会折叠为渐隐预览，点击可展开或收起。

- [#84](https://github.com/MoonshotAI/kimi-code-app/pull/84) [`add8d70`](https://github.com/MoonshotAI/kimi-code-app/commit/add8d70410354d29826d666e5eee52cb77031f60) Thanks [@chengluyu](https://github.com/chengluyu)! - Swarm 与 Goal 的确认弹窗补上规范标题，说明文字移至正文，与其他确认弹窗一致。

- [#105](https://github.com/MoonshotAI/kimi-code-app/pull/105) [`a9d175f`](https://github.com/MoonshotAI/kimi-code-app/commit/a9d175fd117eba180bd71217b3a9abe71e4efc5b) Thanks [@chengluyu](https://github.com/chengluyu)! - 统一「Copy session ID」在标题栏菜单与会话菜单中的大小写，两处文案一致。

- [#93](https://github.com/MoonshotAI/kimi-code-app/pull/93) [`c0fede2`](https://github.com/MoonshotAI/kimi-code-app/commit/c0fede246d68abf1f6e01eff943d4d06e4710aac) Thanks [@liruifengv](https://github.com/liruifengv)! - 设置页新增供应商管理，支持手动添加、从模型目录或私有注册表导入第三方 API 供应商。

- [#92](https://github.com/MoonshotAI/kimi-code-app/pull/92) [`4de4c9c`](https://github.com/MoonshotAI/kimi-code-app/commit/4de4c9c0ffe3f46f4dd9859216e66c0851026428) Thanks [@chengluyu](https://github.com/chengluyu)! - macOS 深色模式下程序坞图标自动切换为深色样式，可在设置中直接预览并选择图标外观。

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - 深色模式图标换成带环形山的满月版本。

- [#106](https://github.com/MoonshotAI/kimi-code-app/pull/106) [`aec4ef0`](https://github.com/MoonshotAI/kimi-code-app/commit/aec4ef0e9f9a5f4daf9154bb44b410ec49f66db8) Thanks [@chengluyu](https://github.com/chengluyu)! - 放大输入框发送与停止按钮的图标，更加醒目。

- [#89](https://github.com/MoonshotAI/kimi-code-app/pull/89) [`bc5cf88`](https://github.com/MoonshotAI/kimi-code-app/commit/bc5cf8825956b5828609159205b752b0c86ad7dc) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Esc 和输入框停止按钮只终止当前回复，不再一并停止后台任务（后台任务可从任务面板单独终止）。

- [#89](https://github.com/MoonshotAI/kimi-code-app/pull/89) [`bc5cf88`](https://github.com/MoonshotAI/kimi-code-app/commit/bc5cf8825956b5828609159205b752b0c86ad7dc) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 终止回复后再按一次 Esc 可撤销刚发出的消息并放回输入框，被终止的回复下方新增「已手动终止」分割线标记。

- [#88](https://github.com/MoonshotAI/kimi-code-app/pull/88) [`35ed68f`](https://github.com/MoonshotAI/kimi-code-app/commit/35ed68f1aa89a484c7be27a45659a08008fbc638) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 修复技能、MCP 等工具调用把「工作中」折叠打断的问题，待办、目标、子代理、提问等卡片在结束后也会一并折入。

- [#100](https://github.com/MoonshotAI/kimi-code-app/pull/100) [`02b134d`](https://github.com/MoonshotAI/kimi-code-app/commit/02b134de92d6c0df4dcb4deb6020ec32f7cb9bf8) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 修复发送消息后同一条用户消息偶尔显示两遍的问题。

- [#82](https://github.com/MoonshotAI/kimi-code-app/pull/82) [`7a3772b`](https://github.com/MoonshotAI/kimi-code-app/commit/7a3772b89e5dc2a5c013a8a2f6cb4b2b1fa848f9) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复窗口全屏时点击关闭按钮变成全黑屏幕的问题。

- [#106](https://github.com/MoonshotAI/kimi-code-app/pull/106) [`aec4ef0`](https://github.com/MoonshotAI/kimi-code-app/commit/aec4ef0e9f9a5f4daf9154bb44b410ec49f66db8) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复发送按钮底部被遮挡一点的问题。

- [#91](https://github.com/MoonshotAI/kimi-code-app/pull/91) [`17ef185`](https://github.com/MoonshotAI/kimi-code-app/commit/17ef185e03c5809e0ab600f15c462fcde3de20c3) Thanks [@OwenXu27](https://github.com/OwenXu27)! - 字体大小设置改为「小 / 中 / 大 / 特大」四档，界面与消息文字随所选档位整体缩放。

- [#96](https://github.com/MoonshotAI/kimi-code-app/pull/96) [`11a593b`](https://github.com/MoonshotAI/kimi-code-app/commit/11a593b4b83efbf77e308d15f000a2c0077d92d0) Thanks [@wbxl2000](https://github.com/wbxl2000)! - goal 模式下自动续跑的轮次会在对话中标注「目标续跑」，方便分清每轮是谁发起的。

- [#105](https://github.com/MoonshotAI/kimi-code-app/pull/105) [`a9d175f`](https://github.com/MoonshotAI/kimi-code-app/commit/a9d175fd117eba180bd71217b3a9abe71e4efc5b) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复斜杠菜单中 /goal 命令的描述只显示「resume」的问题，现在会展示完整的用法说明。

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - Goal 目标图标换新为 Kimi 设计系统的准星图标。

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - 拖拽把手图标换新为 Kimi 设计系统图标。

- [#84](https://github.com/MoonshotAI/kimi-code-app/pull/84) [`add8d70`](https://github.com/MoonshotAI/kimi-code-app/commit/add8d70410354d29826d666e5eee52cb77031f60) Thanks [@chengluyu](https://github.com/chengluyu)! - 更多组件的悬停反馈统一为模式自适应洗色：下拉选择器选项、设置导航与字号步进、归档列表、按钮与 Pill、移动端列表项等，暗色下悬停不再压暗。

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - 界面图标大面积换新为 Kimi 设计系统图标：动作、箭头、文件、状态、置顶、侧栏开关等 40 余处视觉风格统一。

- [#91](https://github.com/MoonshotAI/kimi-code-app/pull/91) [`17ef185`](https://github.com/MoonshotAI/kimi-code-app/commit/17ef185e03c5809e0ab600f15c462fcde3de20c3) Thanks [@OwenXu27](https://github.com/OwenXu27)! - 界面配色切换为 kimi.com 线上配色，状态颜色保持原有配色以保证文字对比度。

- [#91](https://github.com/MoonshotAI/kimi-code-app/pull/91) [`17ef185`](https://github.com/MoonshotAI/kimi-code-app/commit/17ef185e03c5809e0ab600f15c462fcde3de20c3) Thanks [@OwenXu27](https://github.com/OwenXu27)! - macOS 版侧栏换用原生毛玻璃材质，视力敏感的用户可在设置中关闭。

- [#84](https://github.com/MoonshotAI/kimi-code-app/pull/84) [`add8d70`](https://github.com/MoonshotAI/kimi-code-app/commit/add8d70410354d29826d666e5eee52cb77031f60) Thanks [@chengluyu](https://github.com/chengluyu)! - 修正弹出菜单的悬停反馈：暗色下背景改为提亮而非压暗，菜单图标默认降一档显示、悬停时与标签同步提亮。

- [#84](https://github.com/MoonshotAI/kimi-code-app/pull/84) [`add8d70`](https://github.com/MoonshotAI/kimi-code-app/commit/add8d70410354d29826d666e5eee52cb77031f60) Thanks [@chengluyu](https://github.com/chengluyu)! - 单行动作菜单的标签字号由 12px 提升为 13px，更易读。

- [#92](https://github.com/MoonshotAI/kimi-code-app/pull/92) [`4de4c9c`](https://github.com/MoonshotAI/kimi-code-app/commit/4de4c9c0ffe3f46f4dd9859216e66c0851026428) Thanks [@chengluyu](https://github.com/chengluyu)! - 更新应用图标为新版品牌标识，包括系统托盘与界面内的品牌标志。

- [#85](https://github.com/MoonshotAI/kimi-code-app/pull/85) [`d976662`](https://github.com/MoonshotAI/kimi-code-app/commit/d976662a0cfc607e735cc43cd40316c07c79f755) Thanks [@liruifengv](https://github.com/liruifengv)! - 登录界面暂时下线「输入设备码」的备用登录方式（该路径存在问题），保留浏览器一键授权，并新增完整授权链接的复制入口，修复后会恢复。

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - 权限模式指示换上表意图标：手动审批为手掌、YOLO 为警告标志、全自动为机器人。

- [#105](https://github.com/MoonshotAI/kimi-code-app/pull/105) [`a9d175f`](https://github.com/MoonshotAI/kimi-code-app/commit/a9d175fd117eba180bd71217b3a9abe71e4efc5b) Thanks [@chengluyu](https://github.com/chengluyu)! - 统一各界面权限模式的顺序为「逐条确认 → 自动通过 → 完全自主」，颜色警示也随之统一：完全自主始终是最高的红色警示级别。

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - 播放 / 暂停图标换新为 Kimi 设计系统图标（修复暂停图标发灰的问题）。

- [#84](https://github.com/MoonshotAI/kimi-code-app/pull/84) [`add8d70`](https://github.com/MoonshotAI/kimi-code-app/commit/add8d70410354d29826d666e5eee52cb77031f60) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复发送按钮悬停没有过渡动画的问题。

- [#84](https://github.com/MoonshotAI/kimi-code-app/pull/84) [`add8d70`](https://github.com/MoonshotAI/kimi-code-app/commit/add8d70410354d29826d666e5eee52cb77031f60) Thanks [@chengluyu](https://github.com/chengluyu)! - 发送按钮的悬停渐变更清晰可感（时长与幅度上调）。

- [#84](https://github.com/MoonshotAI/kimi-code-app/pull/84) [`add8d70`](https://github.com/MoonshotAI/kimi-code-app/commit/add8d70410354d29826d666e5eee52cb77031f60) Thanks [@chengluyu](https://github.com/chengluyu)! - 发送按钮在输入为空时显示禁用态；启用态改用深灰（反转）填充而非主题色。

- [#84](https://github.com/MoonshotAI/kimi-code-app/pull/84) [`add8d70`](https://github.com/MoonshotAI/kimi-code-app/commit/add8d70410354d29826d666e5eee52cb77031f60) Thanks [@chengluyu](https://github.com/chengluyu)! - 发送按钮的颜色与禁用态变化加入过渡动画，不再瞬变。

- [#84](https://github.com/MoonshotAI/kimi-code-app/pull/84) [`add8d70`](https://github.com/MoonshotAI/kimi-code-app/commit/add8d70410354d29826d666e5eee52cb77031f60) Thanks [@chengluyu](https://github.com/chengluyu)! - 发送按钮的禁用/启用切换过渡更平滑（时长上调至 260ms）。

- [#85](https://github.com/MoonshotAI/kimi-code-app/pull/85) [`d976662`](https://github.com/MoonshotAI/kimi-code-app/commit/d976662a0cfc607e735cc43cd40316c07c79f755) Thanks [@liruifengv](https://github.com/liruifengv)! - 未登录时点击发送会弹出登录引导，输入框下方的模型位置改为登录入口，点击直接弹出登录窗口。没有工作空间时点击发送会先提示选择工作空间，不再直接弹出目录选择器，取消操作会保留已输入的内容。

- [#105](https://github.com/MoonshotAI/kimi-code-app/pull/105) [`a9d175f`](https://github.com/MoonshotAI/kimi-code-app/commit/a9d175fd117eba180bd71217b3a9abe71e4efc5b) Thanks [@chengluyu](https://github.com/chengluyu)! - 统一英文界面按钮与菜单文案的大小写规范：New Chat 改为 New chat，外观选项 Moon Bright / Moon Dark 改为 Moon bright / Moon dark。

- [#97](https://github.com/MoonshotAI/kimi-code-app/pull/97) [`a818544`](https://github.com/MoonshotAI/kimi-code-app/commit/a818544df0453a8a935c1fa033eaa35ea07000bc) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 支持为会话设置 Emoji 图标（选择器可搜索、显示最近使用），在会话选项菜单选择「设置 Emoji…」或点击标题前的 Emoji 即可使用。

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - 设置导航的 Advanced 图标换为 Kimi 显微镜图标。

- [#84](https://github.com/MoonshotAI/kimi-code-app/pull/84) [`add8d70`](https://github.com/MoonshotAI/kimi-code-app/commit/add8d70410354d29826d666e5eee52cb77031f60) Thanks [@chengluyu](https://github.com/chengluyu)! - 设置导航中的「Keyboard Shortcuts」更名为「Hotkeys」（中文为「快捷键」），标签不再折行。

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - 设置导航图标更新：General 换为列表带圆点的滑杆图标，Agent 换为机器人图标。

- [#103](https://github.com/MoonshotAI/kimi-code-app/pull/103) [`2529693`](https://github.com/MoonshotAI/kimi-code-app/commit/25296933069fce9d3f508bbeffd027bdbdcd2ec4) Thanks [@chengluyu](https://github.com/chengluyu)! - 侧边栏「新建会话」和「搜索」的快捷键提示改为鼠标悬停时才显示。

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - 侧栏开关换上 Kimi 左侧栏图标：悬停时箭头飞入并停留在图标中，不再按开合状态切换图形。

- [#106](https://github.com/MoonshotAI/kimi-code-app/pull/106) [`aec4ef0`](https://github.com/MoonshotAI/kimi-code-app/commit/aec4ef0e9f9a5f4daf9154bb44b410ec49f66db8) Thanks [@chengluyu](https://github.com/chengluyu)! - 停止输出按钮改用中性灰底色并去掉红色边框。

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - Swarm 模式及子任务工具调用的图标换为 Kimi 任务网络图标。

- [#94](https://github.com/MoonshotAI/kimi-code-app/pull/94) [`e445851`](https://github.com/MoonshotAI/kimi-code-app/commit/e4458519a63f5fb0ddb35948b3be9a555830a87b) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 后台任务完成、失败或超时时，对话里会显示对应的通知卡片，可展开查看详情和输出文件路径。

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - 设置中的浅色 / 深色主题切换选项加上对应图标。

- [#105](https://github.com/MoonshotAI/kimi-code-app/pull/105) [`a9d175f`](https://github.com/MoonshotAI/kimi-code-app/commit/a9d175fd117eba180bd71217b3a9abe71e4efc5b) Thanks [@chengluyu](https://github.com/chengluyu)! - 模型选择下拉中的 thinking 分组标签改为首字母大写的 Thinking，与界面其他位置保持一致。

- [#91](https://github.com/MoonshotAI/kimi-code-app/pull/91) [`17ef185`](https://github.com/MoonshotAI/kimi-code-app/commit/17ef185e03c5809e0ab600f15c462fcde3de20c3) Thanks [@OwenXu27](https://github.com/OwenXu27)! - 界面边框统一为更细的发丝线，列表选中态与消息气泡改为中性配色。

- [#95](https://github.com/MoonshotAI/kimi-code-app/pull/95) [`aeaae1c`](https://github.com/MoonshotAI/kimi-code-app/commit/aeaae1cdd9bf94eeadcc32b58f8d0925afe26f3f) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 耗时显示不再出现小数秒和原始毫秒，整分钟、整小时省略多余的零（如 6m0s 显示为 6m）。

- [#87](https://github.com/MoonshotAI/kimi-code-app/pull/87) [`3e9e1c3`](https://github.com/MoonshotAI/kimi-code-app/commit/3e9e1c30ea441be3c0fc4a39009bb5185b0b7030) Thanks [@liruifengv](https://github.com/liruifengv)! - 更新弹窗增加「以后自动下载并安装更新」勾选项，下载过程中可切换为后台下载。

- [#87](https://github.com/MoonshotAI/kimi-code-app/pull/87) [`3e9e1c3`](https://github.com/MoonshotAI/kimi-code-app/commit/3e9e1c30ea441be3c0fc4a39009bb5185b0b7030) Thanks [@liruifengv](https://github.com/liruifengv)! - 更新弹窗现在会显示新版本的中英双语更新说明。

- [#87](https://github.com/MoonshotAI/kimi-code-app/pull/87) [`3e9e1c3`](https://github.com/MoonshotAI/kimi-code-app/commit/3e9e1c30ea441be3c0fc4a39009bb5185b0b7030) Thanks [@liruifengv](https://github.com/liruifengv)! - 更新弹窗的更新说明现在按新功能、优化、修复等小节分组展示。

## 0.0.9

### Patch Changes

- [#74](https://github.com/MoonshotAI/kimi-code-app/pull/74) [`3adc4c5`](https://github.com/MoonshotAI/kimi-code-app/commit/3adc4c544f6294541cd9c9f09a28c1b29181ad7a) Thanks [@chengluyu](https://github.com/chengluyu)! - 设置弹窗的导航栏与内容区之间补上细分隔线，浅色模式下两侧不再难以区分。

- [#74](https://github.com/MoonshotAI/kimi-code-app/pull/74) [`3adc4c5`](https://github.com/MoonshotAI/kimi-code-app/commit/3adc4c544f6294541cd9c9f09a28c1b29181ad7a) Thanks [@chengluyu](https://github.com/chengluyu)! - 深色模式下设置页的下拉框、字号步进器等字段控件现在比卡片背景再浅一级，控件更清晰可辨。

- [#76](https://github.com/MoonshotAI/kimi-code-app/pull/76) [`14c197a`](https://github.com/MoonshotAI/kimi-code-app/commit/14c197ae20b32331e216b9a2876b0a699e5837d1) Thanks [@liruifengv](https://github.com/liruifengv)! - App 菜单移除「打开服务日志」项，并为「重试连接」项补充英文文案。

- [#77](https://github.com/MoonshotAI/kimi-code-app/pull/77) [`a24ac7b`](https://github.com/MoonshotAI/kimi-code-app/commit/a24ac7b644498b0becca002b881c525feda4e134) Thanks [@liruifengv](https://github.com/liruifengv)! - 回答提问后，转录中会以回执卡展示你选中的选项；跳过的问题显示为一行简洁的未作答记录。

- [#80](https://github.com/MoonshotAI/kimi-code-app/pull/80) [`44d5398`](https://github.com/MoonshotAI/kimi-code-app/commit/44d539830d304a0c61573d7fce000bcbede4ca7b) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复流式输出中展开或收起思考、工具调用等内容时对话视图抖动的问题：展开或收起时当前行保持原位，内容离开底部后会显示「新消息」提示，收起后按位置自动恢复；展开正在输出中的思考或工具时会跟随输出继续滚动。修复写入、编辑工具展开的代码高亮在流式过程中持续闪烁的问题，以及已完成的思考块在其他内容流式时错误播放呼吸动画的问题。点击目录或「新消息」按钮的定位也更准确。等待回复的月亮动画保持恒定速度。

- [#78](https://github.com/MoonshotAI/kimi-code-app/pull/78) [`a3fab4d`](https://github.com/MoonshotAI/kimi-code-app/commit/a3fab4d9ed88f308993a9928819754bed2c481a8) Thanks [@chengluyu](https://github.com/chengluyu)! - 输入区域与上方任务胶囊采用更协调的圆角、尺寸与轻量焦点反馈，操作区域更整洁。

- [#55](https://github.com/MoonshotAI/kimi-code-app/pull/55) [`189e780`](https://github.com/MoonshotAI/kimi-code-app/commit/189e780091151cb65c2d2ce90b3c57031c8d6473) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 新会话页的工作区选择器改为附着在输入框卡片下方的浅灰卡片，输入框边框保持完整；选择面板按「最近的文件夹」分组展示，下方空间不足时自动向上展开。

- [#81](https://github.com/MoonshotAI/kimi-code-app/pull/81) [`fcbb4e8`](https://github.com/MoonshotAI/kimi-code-app/commit/fcbb4e83eba32e96ce7bc30c8062887f8be6ef02) Thanks [@liruifengv](https://github.com/liruifengv)! - 界面提示中的“daemon”统一改为“服务器”，空列表等场景改为直接提示暂无内容。

- [#77](https://github.com/MoonshotAI/kimi-code-app/pull/77) [`a24ac7b`](https://github.com/MoonshotAI/kimi-code-app/commit/a24ac7b644498b0becca002b881c525feda4e134) Thanks [@liruifengv](https://github.com/liruifengv)! - 计划、审批与提问卡片的视觉更收敛：圆角与阴影减小，提问选项的勾选标记改为与首行文字对齐，卡片操作按钮统一靠左，多步提问的「返回」更名为「上一题」，问题前的分类标签不再显示。计划内容滚动时，顶部会出现柔和的阴影分隔。

- [#76](https://github.com/MoonshotAI/kimi-code-app/pull/76) [`14c197a`](https://github.com/MoonshotAI/kimi-code-app/commit/14c197ae20b32331e216b9a2876b0a699e5837d1) Thanks [@liruifengv](https://github.com/liruifengv)! - 桌面端窗口标题保持静态 Kimi Code，避免运行中的 spinner 符号进入 Dock 菜单。

- [#79](https://github.com/MoonshotAI/kimi-code-app/pull/79) [`e8024fb`](https://github.com/MoonshotAI/kimi-code-app/commit/e8024fb5f14b36f5dc9a1ff9e359c53df9bf6239) Thanks [@chengluyu](https://github.com/chengluyu)! - 拖拽面板宽度到极限时，光标会变为仅剩可拖方向的样式，提示更明确。

- [#76](https://github.com/MoonshotAI/kimi-code-app/pull/76) [`14c197a`](https://github.com/MoonshotAI/kimi-code-app/commit/14c197ae20b32331e216b9a2876b0a699e5837d1) Thanks [@liruifengv](https://github.com/liruifengv)! - 桌面端 Dock 图标根据未读/待处理消息总数显示数字 badge。

- [#74](https://github.com/MoonshotAI/kimi-code-app/pull/74) [`3adc4c5`](https://github.com/MoonshotAI/kimi-code-app/commit/3adc4c544f6294541cd9c9f09a28c1b29181ad7a) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复深色模式下差异视图的中性标记与空状态图标、文件预览的下载按钮悬停几乎不可见的问题。

- [#74](https://github.com/MoonshotAI/kimi-code-app/pull/74) [`3adc4c5`](https://github.com/MoonshotAI/kimi-code-app/commit/3adc4c544f6294541cd9c9f09a28c1b29181ad7a) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复深色模式下界面层次颠倒的问题：代码块、工具输出、输入框等重要内容现在比侧边栏等界面元素更亮，主次更分明。

- [#72](https://github.com/MoonshotAI/kimi-code-app/pull/72) [`bae2c0a`](https://github.com/MoonshotAI/kimi-code-app/commit/bae2c0ae9011d5b9bfb4f4df609cda7a7818914b) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复在设置中退出登录后界面仍显示已登录的问题，现在退出后账号状态会立即刷新。

- [#74](https://github.com/MoonshotAI/kimi-code-app/pull/74) [`3adc4c5`](https://github.com/MoonshotAI/kimi-code-app/commit/3adc4c544f6294541cd9c9f09a28c1b29181ad7a) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复设置页外观选项（Moon Bright / Moon Dark）在空间不足时文字折行、分段控件被撑高的问题。

- [#74](https://github.com/MoonshotAI/kimi-code-app/pull/74) [`3adc4c5`](https://github.com/MoonshotAI/kimi-code-app/commit/3adc4c544f6294541cd9c9f09a28c1b29181ad7a) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复深色模式下设置弹窗的层次问题：设置分组现在比窗口背景浅一级，内容更突出。

- [#81](https://github.com/MoonshotAI/kimi-code-app/pull/81) [`fcbb4e8`](https://github.com/MoonshotAI/kimi-code-app/commit/fcbb4e83eba32e96ce7bc30c8062887f8be6ef02) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复部分模型上下文容量显示不准确的问题。

- [#72](https://github.com/MoonshotAI/kimi-code-app/pull/72) [`bae2c0a`](https://github.com/MoonshotAI/kimi-code-app/commit/bae2c0ae9011d5b9bfb4f4df609cda7a7818914b) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复首次启动引导在开发环境反复弹出的问题：引导完成状态改为主进程持久化存储，开发版与正式版共享，不再受 dev 端口变化影响。

- [#76](https://github.com/MoonshotAI/kimi-code-app/pull/76) [`14c197a`](https://github.com/MoonshotAI/kimi-code-app/commit/14c197ae20b32331e216b9a2876b0a699e5837d1) Thanks [@liruifengv](https://github.com/liruifengv)! - 统一 onboarding 欢迎页品牌文案大小写为 Kimi Code。

- [#72](https://github.com/MoonshotAI/kimi-code-app/pull/72) [`bae2c0a`](https://github.com/MoonshotAI/kimi-code-app/commit/bae2c0ae9011d5b9bfb4f4df609cda7a7818914b) Thanks [@liruifengv](https://github.com/liruifengv)! - 重做首次启动引导：语言与外观偏好、Kimi 账号登录合并为两步向导，未登录不再拦截主界面，之后可在设置中随时登录。

- [#72](https://github.com/MoonshotAI/kimi-code-app/pull/72) [`bae2c0a`](https://github.com/MoonshotAI/kimi-code-app/commit/bae2c0ae9011d5b9bfb4f4df609cda7a7818914b) Thanks [@liruifengv](https://github.com/liruifengv)! - 设置页的账户区新增「套餐用量」，登录 Kimi 账号后可查看额度使用情况和加油包余额。

- [#81](https://github.com/MoonshotAI/kimi-code-app/pull/81) [`fcbb4e8`](https://github.com/MoonshotAI/kimi-code-app/commit/fcbb4e83eba32e96ce7bc30c8062887f8be6ef02) Thanks [@liruifengv](https://github.com/liruifengv)! - 发送消息时附带的视频现在会直接以视频形式传给模型，内容理解更准确。

- [#76](https://github.com/MoonshotAI/kimi-code-app/pull/76) [`14c197a`](https://github.com/MoonshotAI/kimi-code-app/commit/14c197ae20b32331e216b9a2876b0a699e5837d1) Thanks [@liruifengv](https://github.com/liruifengv)! - 在侧边栏设置入口旁添加「内部测试」标识。

- [#79](https://github.com/MoonshotAI/kimi-code-app/pull/79) [`e8024fb`](https://github.com/MoonshotAI/kimi-code-app/commit/e8024fb5f14b36f5dc9a1ff9e359c53df9bf6239) Thanks [@chengluyu](https://github.com/chengluyu)! - 拖拽调整左右侧面板宽度时更流畅，不再出现明显卡顿。

- [#74](https://github.com/MoonshotAI/kimi-code-app/pull/74) [`3adc4c5`](https://github.com/MoonshotAI/kimi-code-app/commit/3adc4c544f6294541cd9c9f09a28c1b29181ad7a) Thanks [@chengluyu](https://github.com/chengluyu)! - 统一了界面分隔线的颜色与粗细，代码块、图片缩略图等内容卡片的边框更纤细。

- [#72](https://github.com/MoonshotAI/kimi-code-app/pull/72) [`bae2c0a`](https://github.com/MoonshotAI/kimi-code-app/commit/bae2c0ae9011d5b9bfb4f4df609cda7a7818914b) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复窗口在最大化或全屏状态下关闭后、下次启动仍以全屏大小打开的问题，现在会恢复上次的正常窗口尺寸。

## 0.0.8

### Patch Changes

- [#68](https://github.com/MoonshotAI/kimi-code-app/pull/68) [`cddc1e3`](https://github.com/MoonshotAI/kimi-code-app/commit/cddc1e355202f6ff4081038ad557cb247382d725) Thanks [@liruifengv](https://github.com/liruifengv)! - 设置的账户页改版：登录状态以卡片展示，未登录时可直接点击登录。

- [#65](https://github.com/MoonshotAI/kimi-code-app/pull/65) [`ae7a176`](https://github.com/MoonshotAI/kimi-code-app/commit/ae7a176157448e258e327f1229c4c7463af69cb5) Thanks [@liruifengv](https://github.com/liruifengv)! - 新增自定义键盘快捷键：为打开设置（⌘,）、收起侧边栏（⌘B）、归档当前会话、侧边聊天、打开文件夹、在默认应用中打开等操作加了默认快捷键，发送和换行也可在设置 → 键盘快捷键中自由重绑。

- [#69](https://github.com/MoonshotAI/kimi-code-app/pull/69) [`9c0169d`](https://github.com/MoonshotAI/kimi-code-app/commit/9c0169d784fab2e2ce13e12c6cc4ecef1232cf89) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 修复发送图片后缩略图先闪一下裂图再加载出来的问题。

- [#59](https://github.com/MoonshotAI/kimi-code-app/pull/59) [`8b718fd`](https://github.com/MoonshotAI/kimi-code-app/commit/8b718fd57ededde0e029d8321ef187ae29c9add8) Thanks [@chengluyu](https://github.com/chengluyu)! - 目标状态从全宽横条改为与待办、子 Agent 一致的小 pill，点击在停靠面板中查看目标详情并进行暂停、继续、取消操作。

- [#66](https://github.com/MoonshotAI/kimi-code-app/pull/66) [`261cd20`](https://github.com/MoonshotAI/kimi-code-app/commit/261cd203b608f72091a507f38811cd88356d3ab0) Thanks [@liruifengv](https://github.com/liruifengv)! - 设置里的三个通知开关合并为一个「系统通知」总开关（默认开启），「提示音」开关改为控制通知是否随附系统提示音。

- [#71](https://github.com/MoonshotAI/kimi-code-app/pull/71) [`eb28f92`](https://github.com/MoonshotAI/kimi-code-app/commit/eb28f92b714dacbeecae9e31fff173f999cb0f53) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复桌面宠物更新后默认开启的问题，现在默认保持隐藏，可从菜单 View → Kimi Pet 手动开启。

- [#64](https://github.com/MoonshotAI/kimi-code-app/pull/64) [`c2d2470`](https://github.com/MoonshotAI/kimi-code-app/commit/c2d2470e97116013ba44015aad34451464f53118) Thanks [@chengluyu](https://github.com/chengluyu)! - 支持置顶会话：悬停会话行点图钉按钮、从会话菜单置顶，或直接把会话拖进侧栏顶部「置顶」区，拖回原工作区即可取消置顶。置顶区内可拖拽调整顺序，悬停可查看会话所属的工作区和路径。

- [#68](https://github.com/MoonshotAI/kimi-code-app/pull/68) [`cddc1e3`](https://github.com/MoonshotAI/kimi-code-app/commit/cddc1e355202f6ff4081038ad557cb247382d725) Thanks [@liruifengv](https://github.com/liruifengv)! - 设置中移除了「显示对话目录」和「合并所有可用 Skills」开关以及账户页的引导入口，对话目录改为始终显示。

- [#68](https://github.com/MoonshotAI/kimi-code-app/pull/68) [`cddc1e3`](https://github.com/MoonshotAI/kimi-code-app/commit/cddc1e355202f6ff4081038ad557cb247382d725) Thanks [@liruifengv](https://github.com/liruifengv)! - 设置弹窗的标题移到左侧栏顶部，各区块标题字号与卡片对齐更统一。

- [#71](https://github.com/MoonshotAI/kimi-code-app/pull/71) [`eb28f92`](https://github.com/MoonshotAI/kimi-code-app/commit/eb28f92b714dacbeecae9e31fff173f999cb0f53) Thanks [@liruifengv](https://github.com/liruifengv)! - 支持系统级全局快捷键唤起应用窗口，默认 Cmd+Shift+Space（macOS）/ Ctrl+Shift+Space（其他系统），可在设置的键盘快捷键中自定义。

- [#70](https://github.com/MoonshotAI/kimi-code-app/pull/70) [`3d6b2d6`](https://github.com/MoonshotAI/kimi-code-app/commit/3d6b2d6f60e737ce0af29edc495195d2a20e2ffa) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 修复透明背景的图片在聊天和文件预览中看不见的问题，白色、黑色内容在亮色和暗色主题下都清晰可见。

## 0.0.7

### Patch Changes

- [#62](https://github.com/MoonshotAI/kimi-code-app/pull/62) [`946c196`](https://github.com/MoonshotAI/kimi-code-app/commit/946c1968c9d9c8d4a1eb33ea0d3ee233025819dd) Thanks [@liruifengv](https://github.com/liruifengv)! - 应用菜单新增「设置…」（快捷键 Cmd/Ctrl+,）和「检查更新…」:检查到有新版本时可直接下载,结果通过原生弹窗反馈。

- [#44](https://github.com/MoonshotAI/kimi-code-app/pull/44) [`e6c96c7`](https://github.com/MoonshotAI/kimi-code-app/commit/e6c96c74d727eb9c7206fbf8533cbb9e582fe8d0) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复 macOS 上会话菜单打开后，点击窗口顶部拖拽区域（聊天标题栏、侧栏标题栏等）无法关闭菜单的问题。

- [#51](https://github.com/MoonshotAI/kimi-code-app/pull/51) [`2cb8bc2`](https://github.com/MoonshotAI/kimi-code-app/commit/2cb8bc2486d6c80f0d5b4ca316510d277693ac53) Thanks [@liruifengv](https://github.com/liruifengv)! - macOS 上支持 Cmd+W 关闭窗口：关窗后应用隐藏在后台驻留，从 Dock 或托盘重新打开即时响应。

- [#57](https://github.com/MoonshotAI/kimi-code-app/pull/57) [`6fdf4bc`](https://github.com/MoonshotAI/kimi-code-app/commit/6fdf4bc68490ee963d4284596c3fb24440fa523f) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 定时提醒消息重新排版：标题、原始 cron 表达式、触发状态收进气泡右上方的一行浅灰标签（任务 ID 移到悬停提示），气泡下方只保留触发时间。

- [#54](https://github.com/MoonshotAI/kimi-code-app/pull/54) [`10dc455`](https://github.com/MoonshotAI/kimi-code-app/commit/10dc455ea1588bbddf9d48399bba552b72768c7f) Thanks [@liruifengv](https://github.com/liruifengv)! - 新增桌面宠物「小蓝」（仅 macOS）：官方动态形象常驻桌面，平时会眨眼、左顾右盼，点一下会随机做动作，可以拖到任意位置，View 菜单可开关。

- [#63](https://github.com/MoonshotAI/kimi-code-app/pull/63) [`aeebb44`](https://github.com/MoonshotAI/kimi-code-app/commit/aeebb44c913f8684238a6696ca9f8aff3e329dc3) Thanks [@liruifengv](https://github.com/liruifengv)! - 支持把文件夹直接拖到侧边栏创建工作区，可一次拖入多个。

- [#62](https://github.com/MoonshotAI/kimi-code-app/pull/62) [`946c196`](https://github.com/MoonshotAI/kimi-code-app/commit/946c1968c9d9c8d4a1eb33ea0d3ee233025819dd) Thanks [@liruifengv](https://github.com/liruifengv)! - 系统菜单新增「文件」菜单:新建会话(⌘N)可直接使用,新建窗口(⇧⌘N)、打开文件夹…(⌘O)先行展示(功能后续接入),「关闭窗口」(⌘W)移至该菜单。

- [#62](https://github.com/MoonshotAI/kimi-code-app/pull/62) [`946c196`](https://github.com/MoonshotAI/kimi-code-app/commit/946c1968c9d9c8d4a1eb33ea0d3ee233025819dd) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复系统菜单中「关于」「退出」等菜单项显示为内部包名 kimi-code-app 的问题,现在正确显示 Kimi Code。

- [#58](https://github.com/MoonshotAI/kimi-code-app/pull/58) [`a3c0f09`](https://github.com/MoonshotAI/kimi-code-app/commit/a3c0f097dbeca0ad8c075e84357d412949e24621) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复多个输入框在中文输入法下按回车确认候选词会直接提交的问题，涉及会话与工作空间重命名、会话搜索、提问与审批回复、模型选择和添加工作空间。

- [#62](https://github.com/MoonshotAI/kimi-code-app/pull/62) [`946c196`](https://github.com/MoonshotAI/kimi-code-app/commit/946c1968c9d9c8d4a1eb33ea0d3ee233025819dd) Thanks [@liruifengv](https://github.com/liruifengv)! - 系统菜单新增「帮助」菜单,可直接打开 Kimi Code 文档和控制台(网页)。

- [#63](https://github.com/MoonshotAI/kimi-code-app/pull/63) [`aeebb44`](https://github.com/MoonshotAI/kimi-code-app/commit/aeebb44c913f8684238a6696ca9f8aff3e329dc3) Thanks [@liruifengv](https://github.com/liruifengv)! - 新建工作区后，侧边栏会以选中底色标出该工作区行；切换会话或发出第一条消息后恢复。

- [#45](https://github.com/MoonshotAI/kimi-code-app/pull/45) [`48f01c4`](https://github.com/MoonshotAI/kimi-code-app/commit/48f01c46be88a9967937aecf49433a996969efe2) Thanks [@chengluyu](https://github.com/chengluyu)! - 会话标题右侧菜单、工作区菜单和对话菜单打开时，加入与模型切换器一致的弹出动画。

- [#49](https://github.com/MoonshotAI/kimi-code-app/pull/49) [`96d9890`](https://github.com/MoonshotAI/kimi-code-app/commit/96d9890d22999d1a1c64c899cc46dc171d1349ac) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复新增工作区在侧栏被排到最后的问题，新增后会显示在最上面。

- [#61](https://github.com/MoonshotAI/kimi-code-app/pull/61) [`4e114e9`](https://github.com/MoonshotAI/kimi-code-app/commit/4e114e993cc95aa69ba71b665b4f63dd959814e7) Thanks [@liruifengv](https://github.com/liruifengv)! - 移除设置中的黑色主题色选项，界面主题色统一为蓝色。

- [#45](https://github.com/MoonshotAI/kimi-code-app/pull/45) [`48f01c4`](https://github.com/MoonshotAI/kimi-code-app/commit/48f01c46be88a9967937aecf49433a996969efe2) Thanks [@chengluyu](https://github.com/chengluyu)! - 右键点击侧栏中的对话项时，可打开与 ⋯ 按钮相同的会话菜单。

- [#56](https://github.com/MoonshotAI/kimi-code-app/pull/56) [`4086a24`](https://github.com/MoonshotAI/kimi-code-app/commit/4086a24a0ab64a0ef6f2f75d5829a381ab78289f) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 修复会话运行中界面卡顿、操作响应缓慢的问题，会话和历史较多时改善尤其明显。

- [#50](https://github.com/MoonshotAI/kimi-code-app/pull/50) [`a142fae`](https://github.com/MoonshotAI/kimi-code-app/commit/a142faeec1bc283dbf9ce9f560f66c62836d655e) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复等待审批或回答问题期间思考计时仍在走、且最终时长计入等待时间的问题。

- [#52](https://github.com/MoonshotAI/kimi-code-app/pull/52) [`4496406`](https://github.com/MoonshotAI/kimi-code-app/commit/4496406cfe43172b8d91e8b58a3e65334ce1f47a) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 每轮回复结束后，思考过程、工具调用等中间内容自动折叠成一行「已工作 Ns」，消息流只保留最终正文，点击该行可展开查看完整过程。

- [#43](https://github.com/MoonshotAI/kimi-code-app/pull/43) [`f9f6a4c`](https://github.com/MoonshotAI/kimi-code-app/commit/f9f6a4c9268be2ce3f9fbc0641e402043bc4de53) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复工具调用行里小写字母降部（如 j、p、g、y）被截断显示不全的问题。

- [#51](https://github.com/MoonshotAI/kimi-code-app/pull/51) [`2cb8bc2`](https://github.com/MoonshotAI/kimi-code-app/commit/2cb8bc2486d6c80f0d5b4ca316510d277693ac53) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复点击托盘菜单或系统通知中的会话无法跳转打开的问题。

- [#53](https://github.com/MoonshotAI/kimi-code-app/pull/53) [`57b0b4c`](https://github.com/MoonshotAI/kimi-code-app/commit/57b0b4c0bdf5afa952be65024fdbcf3d22631130) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 发送的图片和视频在消息气泡里显示为圆角缩略图，不再显示文件名；点击弹出浮窗预览，视频可直接播放。

- [#49](https://github.com/MoonshotAI/kimi-code-app/pull/49) [`96d9890`](https://github.com/MoonshotAI/kimi-code-app/commit/96d9890d22999d1a1c64c899cc46dc171d1349ac) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复点击正在运行的会话后，其所在工作区在侧栏突然跳到最上面的问题。

## 0.0.6

### Patch Changes

- [#46](https://github.com/MoonshotAI/kimi-code-app/pull/46) [`7ac176f`](https://github.com/MoonshotAI/kimi-code-app/commit/7ac176f9a9ff71821b637d23e53e932874db63bc) Thanks [@liruifengv](https://github.com/liruifengv)! - 设置的高级页新增应用版本与构建时间展示和手动检查更新按钮，并将页面选项整理为版本与更新、数据与隐私、诊断三组。

- [#42](https://github.com/MoonshotAI/kimi-code-app/pull/42) [`177c68c`](https://github.com/MoonshotAI/kimi-code-app/commit/177c68c90effc14aa13d8c4462c6c4fdc2058f55) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复发送首条消息进入消息流、以及切换到其它会话后，输入框不会自动聚焦的问题。

- [#41](https://github.com/MoonshotAI/kimi-code-app/pull/41) [`7d7365d`](https://github.com/MoonshotAI/kimi-code-app/commit/7d7365dd439577b6dbf380e7df40673c08e4dd05) Thanks [@liruifengv](https://github.com/liruifengv)! - 窗口标题与应用内各处的品牌名统一为「Kimi Code」。

- [#46](https://github.com/MoonshotAI/kimi-code-app/pull/46) [`7ac176f`](https://github.com/MoonshotAI/kimi-code-app/commit/7ac176f9a9ff71821b637d23e53e932874db63bc) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复设置里服务端版本错误显示为应用版本的问题，现在正确显示内嵌核心引擎的版本。

- [#37](https://github.com/MoonshotAI/kimi-code-app/pull/37) [`7c90df8`](https://github.com/MoonshotAI/kimi-code-app/commit/7c90df89815e0c56fc0cfbc2eec830cb1ffb347f) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 修复对话中读取视频文件后播放器黑屏、无法预览内容的问题。

- [#40](https://github.com/MoonshotAI/kimi-code-app/pull/40) [`a2c4ed8`](https://github.com/MoonshotAI/kimi-code-app/commit/a2c4ed86225bd3bdcf5706f21e7a6dc337bd73ba) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 修复系统提醒注入把回合切断、导致连续活动被折成多行的问题，现在一整段活动正常折成一行。

- [#40](https://github.com/MoonshotAI/kimi-code-app/pull/40) [`a2c4ed8`](https://github.com/MoonshotAI/kimi-code-app/commit/a2c4ed86225bd3bdcf5706f21e7a6dc337bd73ba) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 修复进行中的摘要会把还在运行的工具提前计入「已完成」统计的问题。

- [#47](https://github.com/MoonshotAI/kimi-code-app/pull/47) [`e48bbf5`](https://github.com/MoonshotAI/kimi-code-app/commit/e48bbf5e01f2e1fb6e3d35bd11c7c5267a9ef3b3) Thanks [@liruifengv](https://github.com/liruifengv)! - 使用 API Key 接入 Kimi 编程模型时，会自动获取最新的模型列表。

- [#47](https://github.com/MoonshotAI/kimi-code-app/pull/47) [`e48bbf5`](https://github.com/MoonshotAI/kimi-code-app/commit/e48bbf5e01f2e1fb6e3d35bd11c7c5267a9ef3b3) Thanks [@liruifengv](https://github.com/liruifengv)! - 模型选择菜单新增提示：切换模型或思考强度会使已有的提示词缓存失效，建议新建对话以避免额外 token 消耗。

- [#47](https://github.com/MoonshotAI/kimi-code-app/pull/47) [`e48bbf5`](https://github.com/MoonshotAI/kimi-code-app/commit/e48bbf5e01f2e1fb6e3d35bd11c7c5267a9ef3b3) Thanks [@liruifengv](https://github.com/liruifengv)! - 修正自动与 YOLO 权限模式的说明文案，与其实际行为一致。

- [#47](https://github.com/MoonshotAI/kimi-code-app/pull/47) [`e48bbf5`](https://github.com/MoonshotAI/kimi-code-app/commit/e48bbf5e01f2e1fb6e3d35bd11c7c5267a9ef3b3) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复排队待发的消息被自动补发时可能携带过期附件的问题。

- [#47](https://github.com/MoonshotAI/kimi-code-app/pull/47) [`e48bbf5`](https://github.com/MoonshotAI/kimi-code-app/commit/e48bbf5e01f2e1fb6e3d35bd11c7c5267a9ef3b3) Thanks [@liruifengv](https://github.com/liruifengv)! - 思考强度改为按会话生效：每个会话保持自己的设置，切换会话或模型时互不影响。

- [#36](https://github.com/MoonshotAI/kimi-code-app/pull/36) [`58636df`](https://github.com/MoonshotAI/kimi-code-app/commit/58636dffa767ae386b7757fa6ba769c30fc5ae88) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 侧边栏多个会话同时运行时，加载动画现在保持同步转动。

- [#47](https://github.com/MoonshotAI/kimi-code-app/pull/47) [`e48bbf5`](https://github.com/MoonshotAI/kimi-code-app/commit/e48bbf5e01f2e1fb6e3d35bd11c7c5267a9ef3b3) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复在符号链接目录下的问题：AGENTS.md 无法生效、文件状态读取失败。

- [#39](https://github.com/MoonshotAI/kimi-code-app/pull/39) [`7b7ff5f`](https://github.com/MoonshotAI/kimi-code-app/commit/7b7ff5f1433b8f9bec60e69f8d34f74b8dd95050) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Mac 菜单栏图标旁现在会显示未读、待审批和待回答的总数，点开托盘菜单可按会话逐条查看并直接跳转到对应会话，菜单语言跟随应用语言设置。

- [#40](https://github.com/MoonshotAI/kimi-code-app/pull/40) [`a2c4ed8`](https://github.com/MoonshotAI/kimi-code-app/commit/a2c4ed86225bd3bdcf5706f21e7a6dc337bd73ba) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 连续的思考与工具调用自动折叠成一行摘要（如「读取了 2 个文件 · 运行了 5 条命令 · 26.8s」），进行中实时展开直播、结束后自动收起，消息流更安静。

- [#35](https://github.com/MoonshotAI/kimi-code-app/pull/35) [`aeb9384`](https://github.com/MoonshotAI/kimi-code-app/commit/aeb93843770d2d0f563015d99e342cb3c0bd3c89) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 聊天中的宽表格默认保持在正文列宽内展示，被截断时右缘有渐隐提示，鼠标悬停后点右上角的按钮即可加宽，再点一次恢复。

## 0.0.5

### Patch Changes

- [#16](https://github.com/MoonshotAI/kimi-code-app/pull/16) [`004f2c1`](https://github.com/MoonshotAI/kimi-code-app/commit/004f2c18dd9710ac8818561fd6c3872265eb1c65) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复滚动时聊天消息从输入框下方透出来的问题。

- [#9](https://github.com/MoonshotAI/kimi-code-app/pull/9) [`05de3b8`](https://github.com/MoonshotAI/kimi-code-app/commit/05de3b843cc905506d948b8fafda5fc37ccca555) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复代码差异文件列表中，以点开头的隐藏文件路径标点位置错乱的问题。

- [#32](https://github.com/MoonshotAI/kimi-code-app/pull/32) [`7ca7c46`](https://github.com/MoonshotAI/kimi-code-app/commit/7ca7c463d783c66680c8bd776ec71339b005c1ab) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复深色主题搭配黑色主题色时，主要按钮白底白字看不清的问题。

- [#33](https://github.com/MoonshotAI/kimi-code-app/pull/33) [`920c389`](https://github.com/MoonshotAI/kimi-code-app/commit/920c389ecca712550eeeff593cc97836455d2100) Thanks [@chengluyu](https://github.com/chengluyu)! - 「打开方式」菜单新增 kitty 终端，可直接用它打开当前工作目录。

- [#33](https://github.com/MoonshotAI/kimi-code-app/pull/33) [`920c389`](https://github.com/MoonshotAI/kimi-code-app/commit/920c389ecca712550eeeff593cc97836455d2100) Thanks [@chengluyu](https://github.com/chengluyu)! - 「打开方式」菜单新增 VS Code Insiders，可直接用它打开当前工作目录。

- [#34](https://github.com/MoonshotAI/kimi-code-app/pull/34) [`f653b6b`](https://github.com/MoonshotAI/kimi-code-app/commit/f653b6bd248b1c93261212a3e0bcfb7789d17f4f) Thanks [@liruifengv](https://github.com/liruifengv)! - 重新设计会话中的工具调用展示：每种工具都有贴合内容的专属样式，同种工具的连续调用合并为一句自然语言摘要（如“读取了 3 个文件”）并在完成后自动收起，子代理以独立卡片呈现、点击直达详情面板。

- [#32](https://github.com/MoonshotAI/kimi-code-app/pull/32) [`7ca7c46`](https://github.com/MoonshotAI/kimi-code-app/commit/7ca7c463d783c66680c8bd776ec71339b005c1ab) Thanks [@liruifengv](https://github.com/liruifengv)! - 重新设计审批与提问卡片：白色浮起圆角卡片，标题改为更大的深色纯文字；操作按钮按 1-4 从左到右排列，数字直接标在按钮上，主要操作是主题蓝实心按钮；写文件审批显示语法高亮的内容预览，编辑文件审批显示语法高亮的行级 diff，内容较多时默认 24 行内滚动、可一键放大撑满阅读；plan 的方案选项固定在计划正文下方（描述固定第二行完整显示），不会被长文淹没，还可以一键放大阅读全文；plan 文件路径渲染成链接，点击在右侧栏预览计划内容；卡片收起后点击整条即可展开；提问卡的标题就是问题本身，新增关闭按钮，选项支持 ↑↓ 方向键选择、空格勾选（多选）、Enter 确认；运行危险命令（如 rm -rf、sudo、强推）时审批卡片会显示危险提示。

- [#30](https://github.com/MoonshotAI/kimi-code-app/pull/30) [`8d0a46e`](https://github.com/MoonshotAI/kimi-code-app/commit/8d0a46e6e13bbb4e4ffba9826634749d93dc3b91) Thanks [@liruifengv](https://github.com/liruifengv)! - 读取、编辑和写入文件工具的卡片展开后显示代码内容，并按文件类型语法高亮；读取结果带真实行号。

## 0.0.4

### Patch Changes

- [#27](https://github.com/MoonshotAI/kimi-code-app/pull/27) [`c1caec3`](https://github.com/MoonshotAI/kimi-code-app/commit/c1caec399d6feef4d4f4a6d69b12605d76757e80) Thanks [@liruifengv](https://github.com/liruifengv)! - 思考过程改为在对话中内联折叠展示，流式时显示"思考中"状态和计秒，点击即可展开查看全文，思考完成后自动收起并显示用时，不再打开右侧面板。

## 0.0.3

### Patch Changes

- [#26](https://github.com/MoonshotAI/kimi-code-app/pull/26) [`034c432`](https://github.com/MoonshotAI/kimi-code-app/commit/034c432d3f849323730271b330870d568c6d6472) Thanks [@liruifengv](https://github.com/liruifengv)! - 支持自动更新：发现新版本后侧栏会出现更新提示，点击下载、下载完成后重启即可完成升级。

- [#22](https://github.com/MoonshotAI/kimi-code-app/pull/22) [`38f6ac6`](https://github.com/MoonshotAI/kimi-code-app/commit/38f6ac6a2298bb4383ee740dc6c502433b6a65fc) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复按 Esc 的连坐打断：关闭弹窗、问答卡或输入框下拉菜单时，不再同时打断正在输出的会话。

- [#24](https://github.com/MoonshotAI/kimi-code-app/pull/24) [`015c299`](https://github.com/MoonshotAI/kimi-code-app/commit/015c299235c22e1a7150ac9c074abc22ef04c19c) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复使用过程中可能突然弹出主进程错误弹窗的问题；桌面端运行日志现在会保存到本地文件，便于排查问题。

- [#25](https://github.com/MoonshotAI/kimi-code-app/pull/25) [`50be936`](https://github.com/MoonshotAI/kimi-code-app/commit/50be93649c1f5727131e92e72a5947aa3fdf0cb9) Thanks [@liruifengv](https://github.com/liruifengv)! - 重新设计输入框里的模型选择器及下拉面板：展开有弹出动画、箭头翻转，思考等级切换与设置页统一为滑动分段控件，支持下拉内方向键选择，键盘操作有清晰的焦点提示。

- [#23](https://github.com/MoonshotAI/kimi-code-app/pull/23) [`a7d3961`](https://github.com/MoonshotAI/kimi-code-app/commit/a7d396196d35d339e378ab2d4bc2d51a0d070346) Thanks [@liruifengv](https://github.com/liruifengv)! - Add an "open in" control to the chat header: open the current workspace in a detected editor or terminal (VS Code, Cursor, Zed, Finder, Terminal, iTerm2, Ghostty, Warp, Xcode on macOS), with a matching default-app select in Settings.

- [#19](https://github.com/MoonshotAI/kimi-code-app/pull/19) [`d857232`](https://github.com/MoonshotAI/kimi-code-app/commit/d85723243253b50e803a07c15975af9cbc62f527) Thanks [@liruifengv](https://github.com/liruifengv)! - 重新设计会话搜索弹窗：关键词高亮更柔和，空结果或无会话时展示占位提示。

- [#21](https://github.com/MoonshotAI/kimi-code-app/pull/21) [`d8b150f`](https://github.com/MoonshotAI/kimi-code-app/commit/d8b150f28584f6fb385cb118285f95bf2d5bcfd2) Thanks [@liruifengv](https://github.com/liruifengv)! - 重新设计模型选择弹窗，并统一所有弹窗的版式：标题栏、搜索框（支持一键清除）、列表与底部快捷键栏采用同一套样式，当前选择以中性底色和对勾标记，键盘上下选择时列表自动跟随滚动。

## 0.0.2

### Patch Changes

- [#17](https://github.com/MoonshotAI/kimi-code-app/pull/17) [`993afae`](https://github.com/MoonshotAI/kimi-code-app/commit/993afaeab2a96bfb70bfd5aeaf87cad7002d1351) Thanks [@liruifengv](https://github.com/liruifengv)! - 应用图标更换为新的蓝色机器人标识。

- [#17](https://github.com/MoonshotAI/kimi-code-app/pull/17) [`993afae`](https://github.com/MoonshotAI/kimi-code-app/commit/993afaeab2a96bfb70bfd5aeaf87cad7002d1351) Thanks [@liruifengv](https://github.com/liruifengv)! - 侧边栏顶部的品牌标识更换为新的机器人形象，眨眼和左右看的动效保留。

- [#17](https://github.com/MoonshotAI/kimi-code-app/pull/17) [`993afae`](https://github.com/MoonshotAI/kimi-code-app/commit/993afaeab2a96bfb70bfd5aeaf87cad7002d1351) Thanks [@liruifengv](https://github.com/liruifengv)! - 系统状态栏图标改为单色剪影，自动适配浅色和深色菜单栏。

- [#17](https://github.com/MoonshotAI/kimi-code-app/pull/17) [`993afae`](https://github.com/MoonshotAI/kimi-code-app/commit/993afaeab2a96bfb70bfd5aeaf87cad7002d1351) Thanks [@liruifengv](https://github.com/liruifengv)! - 新增系统托盘常驻图标，点击托盘图标弹出菜单，可显示主窗口或退出应用。

## 0.0.1

### Patch Changes

- [#13](https://github.com/MoonshotAI/kimi-code-app/pull/13) [`810eeeb`](https://github.com/MoonshotAI/kimi-code-app/commit/810eeebc1ec8ad5d9b934309d789f905570d43b6) Thanks [@chengluyu](https://github.com/chengluyu)! - 聊天输入框关闭浏览器自动填充和拼写检查，输入时不再出现自动填充建议和拼写红线。

- [#2](https://github.com/MoonshotAI/kimi-code-app/pull/2) [`29cf4a6`](https://github.com/MoonshotAI/kimi-code-app/commit/29cf4a6af5bd16d102db2343c71a052e5e00e3e4) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复暗色主题下行内代码看不清的问题，正文文字提亮，侧边栏配色更沉稳。

- [#12](https://github.com/MoonshotAI/kimi-code-app/pull/12) [`e683222`](https://github.com/MoonshotAI/kimi-code-app/commit/e68322298ef432825c899a4e1d8b6fffd4855f2b) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复同一文件夹因路径写法不同（大小写、斜杠差异）而重复显示为多个工作空间的问题。

- [#8](https://github.com/MoonshotAI/kimi-code-app/pull/8) [`7eb005f`](https://github.com/MoonshotAI/kimi-code-app/commit/7eb005fed49a18bf26262defb78160c5c60e66b2) Thanks [@liruifengv](https://github.com/liruifengv)! - 新建对话的空页面现在会展示 Kimi 复古电脑动画，并随明暗主题自动变色。

- [#14](https://github.com/MoonshotAI/kimi-code-app/pull/14) [`62609d2`](https://github.com/MoonshotAI/kimi-code-app/commit/62609d214afc05472ae51d8e7863db846e73e196) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复新建会话等待页顶部无法拖拽窗口的问题。

- [#14](https://github.com/MoonshotAI/kimi-code-app/pull/14) [`62609d2`](https://github.com/MoonshotAI/kimi-code-app/commit/62609d214afc05472ae51d8e7863db846e73e196) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复窗口左上角红绿灯与侧栏开关按钮的对齐问题：红绿灯垂直位置偏低，按钮与红绿灯间距过近。

- [#12](https://github.com/MoonshotAI/kimi-code-app/pull/12) [`e683222`](https://github.com/MoonshotAI/kimi-code-app/commit/e68322298ef432825c899a4e1d8b6fffd4855f2b) Thanks [@liruifengv](https://github.com/liruifengv)! - 工作空间列表和添加工作空间的目录选择中不再显示 git 分支信息。

- [#7](https://github.com/MoonshotAI/kimi-code-app/pull/7) [`be9ccd9`](https://github.com/MoonshotAI/kimi-code-app/commit/be9ccd9ec8522ae5bb9994c87ea438ceb9529695) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复会话列表在回答过程中随每一步频繁跳动重排的问题。
