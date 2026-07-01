# @moonshot-ai/kimi-code

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
