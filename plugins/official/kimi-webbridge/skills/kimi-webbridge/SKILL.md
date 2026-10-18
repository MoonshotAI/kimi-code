---
name: kimi-webbridge
description: |
  Kimi Browser Extension（Kimi 浏览器扩展，原 Kimi WebBridge）lets AI control the user's real browser — navigate, click, type, read, screenshot, and interact with any website using the user's actual login sessions. Use this skill whenever the user wants to interact with websites, automate browser tasks, scrape web content, or perform any action requiring a real browser. Also use when the user mentions "browser", "webpage", "open URL", "screenshot", asks to read/interact with any website, or wants a reusable CLI tool or script that automates a specific website. Use even for simple-sounding browser requests — the daemon handles all complexity.
metadata:
  version: "2.0.24"
---

# Kimi Browser Extension (formerly Kimi WebBridge)

Control the user's real browser (with their login sessions) via a local daemon at `http://127.0.0.1:10086` (the default address — see [If a tool call fails](#if-a-tool-call-fails-daemon-or-extension-not-ready) for when it differs).

When the user asks to build a reusable CLI tool or script for a website (rather than do a one-off task), follow `references/cli-creator/workflow.md`. Its phases say when to read each of these:

- `references/cli-creator/site-exploration.md` — the protocol for finding how each feature gets its data
- `references/cli-creator/login-handling.md` — when the site requires login
- `references/cli-creator/go-layout.md` — when the CLI is written in Go
- `references/cli-creator/companion-skill-template.md` — the template for the skill that tells agents how to use the CLI

## Tools

| Tool | Args | Returns | Note |
|------|------|---------|------|
| `navigate` | `url`, `newTab`(bool), `group_title` | `{success, url, tabId}` | First call opens a tab — see [Tabs](#tabs-and-the-current-tab). `group_title` sets the group's visible label |
| `find_tab` | `url`, `active`(bool) | `{success, url, tabId, borrowed}` | Re-select a tab **this session** opened; `active:true` borrows the tab the **user** is viewing — see [Tabs](#tabs-and-the-current-tab) |
| `snapshot` | optional `ref`; `format:"aria"` opts into text with optional `max_chars` (1–60000), or `cursor` to continue | Default `{url, title, tree}`; ARIA `{url, title, tree_text}` | **Accessibility tree** (text) — use this to read page content and locate elements |
| `click` | `selector` (@e ref or CSS) | `{success, tag, text}` | Synthetic `el.click()` |
| `fill` | `selector`, `value` | `{success, tag, mode}` | Works on `<input>`/`<textarea>` AND `[contenteditable]` (ProseMirror/Lexical/Slate). `mode` is `"value"` or `"contenteditable"` |
| `evaluate` | `code` (for `await`, wrap it in an async IIFE — top-level `await` is a SyntaxError) | `{type, value}` | |
| `cdp` | `method`, `params` | raw CDP response | Raw `chrome.debugger` passthrough — what `evaluate` is to JS, `cdp` is to CDP. Low-level escape hatch for cases the tools above don't cover. `Page.bringToFront` is a last resort: while focus emulation is off on a tab, a call turns it on instead of activating the tab (the tab renders and takes real input without being switched to); only a call once emulation is on activates, and it never pulls Chrome over another app the user is in. `Target.activateTarget` is refused |
| `screenshot` | `format`(png\|jpeg), `quality`(0-100), optional `selector` (@e/CSS), optional `path` | `{format, path, sizeBytes, mimeType}` | Returns a file path, not base64 — see [Screenshots](#screenshots) |
| `network` | `cmd`(start\|stop\|list\|detail), `filter`(URL substring, for `list`), `requestId`(for `detail`) | `list`: `{count, requests:[{requestId, url, method, status, mimeType, completed}]}`; `detail`: that request plus `requestHeaders`, `requestBody`, `body` (the response) | Capture is per tab, from `start` on. Call `detail` before `stop` — stopping releases the response bodies, and `detail` then returns `bodyError` instead of `body` |
| `upload` | `selector`, `files`(string[]) | `{success, fileCount}` | |
| `save_as_pdf` | `paper_format`, `landscape`, `scale`, `print_background`, optional `path` | `{path, sizeBytes, mimeType, pageTitle}` | Render current page → PDF, returns a file path — see [Save as PDF](#save-the-current-page-as-pdf) |
| `list_tabs` | — | `{success, tabs:[{tabId, url, title, active, groupTitle}]}` | Inspect tabs in the current session |
| `list_browser_tabs` | — | `{success, tabs:[{tabId, windowId, url, title, active}]}` | Inspect all tabs visible to this WebBridge connection, across windows; does not attach or focus a tab |
| `attach_tab` | `tabId` | `{success, tabId, url, title, borrowed}` | Attach a specific existing tab to this session without focusing it; borrowed tabs survive `close_session` |
| `close_tab` | — | `{success, closed: bool}` | Close the current tab in the session |
| `close_session` | — | `{success, closed: int}` | Close tabs opened by this session; borrowed tabs stay open. `closed` is the count. See [Sessions](#sessions) for when to call |

### Tabs and the current tab

Single-tab tools (`snapshot`, `click`, `fill`, `screenshot`, `save_as_pdf`) act on the **current tab** — the one you most recently opened with `navigate`, selected with `find_tab`, or attached with `attach_tab`.

- **Opening pages**: use `newTab:true` when pages should coexist (comparing, cross-referencing); omit it to send the current tab to a new URL.
- **Going back to an earlier tab**: call `find_tab` to make a tab **you opened earlier in this session** the current one again. Pass the tab's URL — take it from `list_tabs` or the earlier `navigate` result. Matching is by host: `kimi.com` also finds a `www.kimi.com` tab, and the path is ignored. By default `find_tab` searches **only this session's own tabs** — it never reaches into the user's other tabs or windows.
- **Acting on a page the user already has open**: call `list_browser_tabs`, choose the tab by its URL/title and `tabId`, then call `attach_tab` with that ID. This also works for tabs in other windows and does not change the user's foreground tab. The attached tab is borrowed and remains open after `close_session`. For the particular tab the user is currently viewing, `find_tab` with `active:true` still works.
- If `find_tab` errors with "no tab matching … in this session", the page isn't open in this session — `navigate` with `newTab:true` instead.

```bash
curl -s -X POST http://127.0.0.1:10086/command \
  -d '{"action":"find_tab","args":{"url":"https://www.kimi.com","active":true},"session":"k26-research"}'
```

### Call Format

Every command carries a top-level `session` naming the current task — see [Sessions](#sessions) below. The examples in later sections omit it only for brevity; in real calls always include it. Every reply is an envelope: `{"ok":true,"data":…}` on success (the **Returns** column above describes `data`) or `{"ok":false,"error":{"code","message"}}` on failure. The command format depends on the user's OS.

**macOS / Linux** — inline JSON is fine:

```bash
curl -s -X POST http://127.0.0.1:10086/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"navigate","args":{"url":"https://example.com","newTab":true,"group_title":"My task"},"session":"my-task"}'
```

If the inline call fails — a shell quoting/syntax error from bash, or an HTTP 400 from the daemon — do **not** retry the same command unchanged. Resend the request as a file body:

1. Write the JSON body to a **uniquely-named** temp file with your own file-write tool — never with shell `echo`/heredoc, which mangles the JSON the same way. Use a fresh name per request (e.g. `/tmp/webbridge-req-<random>.json`).
2. POST the file:

```bash
curl -s -X POST http://127.0.0.1:10086/command -H 'Content-Type: application/json' --data-binary @/tmp/webbridge-req-<random>.json
```

3. Delete the temp file as soon as the request returns.

**Windows (PowerShell / cmd)** — the shell corrupts non-ASCII characters (Chinese etc.) carried inline in command arguments or pipes; they reach the daemon as `?` and the text is unrecoverable. Send **every** request as a file body instead:

1. Write the JSON body to a **uniquely-named** temp file with your own file-write tool — never with shell `echo`/heredoc, which corrupts non-ASCII the same way. Give **every** request its own filename with a random suffix (e.g. `webbridge-req-<random>.json`) so concurrent requests never share a file and overwrite each other.
2. POST the file with `curl.exe` — always `curl.exe`, never bare `curl`, which Windows PowerShell aliases to `Invoke-WebRequest`:

```powershell
curl.exe -s -X POST http://127.0.0.1:10086/command -H "Content-Type: application/json" --data-binary "@$env:TEMP\webbridge-req-<random>.json"
```

3. Delete the temp file as soon as the request returns — don't leave request bodies on disk.

## Sessions

**One task = one session = one tab group.** A `session` collects every tab the task opens into one tab group, so the user sees a single group for "what the agent is doing right now". Pass it as a **top-level field** of the request body (not inside `args`).

- **Pick one session name at the task's start, put it on every command, and never switch mid-task — even across different sites.** Switching session names per site is the #1 cause of fragmented tab groups.
- Name it after the **task**, not the site (`camping-research`, `phone-compare`). Use multiple sessions only for genuinely unrelated parallel tasks.
- `group_title` is the human-readable group label — write it in the user's language, on the **first** `navigate` of the task.
- When you create the group (the first `navigate` of a task), tell the user once that this task's pages are collected under group «title», and that you'll close them whenever they ask.

```bash
# First tab: set session + a human label (in the user's language)
curl -s -X POST http://127.0.0.1:10086/command \
  -d '{"action":"navigate","args":{"url":"https://www.kimi.com","newTab":true,"group_title":"K2.6 feature research"},"session":"k26-research"}'
# Another site, same task → same session → joins the same group automatically
curl -s -X POST http://127.0.0.1:10086/command \
  -d '{"action":"navigate","args":{"url":"https://www.moonshot.cn","newTab":true},"session":"k26-research"}'
```

Closing is always user-initiated: call `close_session` only when the user explicitly asks ("close those", "clear the tabs"). It clears the whole group in one call.

## Screenshots

The daemon writes the image to disk and returns `{format, path, sizeBytes, mimeType}` — never base64, since the model can't read raw image bytes. Take the `.path` and open it with the `Read` tool to actually see it.

```bash
# Default: PNG of the visible viewport, daemon picks a temp path
curl ... -d '{"action":"screenshot","args":{}}'
# Options (each independent): JPEG quality, element-only via @e/CSS selector, custom output path
curl ... -d '{"action":"screenshot","args":{"format":"jpeg","quality":60}}'
curl ... -d '{"action":"screenshot","args":{"selector":"@e123"}}'
```

A caller-supplied `path` is honored verbatim (parent dirs created, existing file overwritten) — use a unique name to avoid clobbering. `save_as_pdf` follows the same rule.

## Prefer snapshot over CSS/JS selectors

`snapshot` returns interactive elements with `@e` refs bound to the observed DOM nodes. Copy refs as opaque strings into click/fill. Re-reading a page preserves refs for the same nodes; a removed node or changed document/connection requires a fresh snapshot. Refs never automatically select a replacement by name.

For bounded text reads, call `snapshot` with `format:"aria"` and optionally `max_chars` (default 60000). This bounds `tree_text`, not metadata. If `truncated:true`, pass `next_cursor` back as `cursor` (without `ref`) to continue the same saved observation; `continued:true` identifies subsequent chunks. Concatenate `tree_text` without extra separators: chunks can split long lines, and budgets count UTF-16 code units without splitting surrogate pairs (a budget of 1 errors when the next character needs 2). Cursors expire after five minutes, cache eviction, navigation or connection reset; start a new snapshot on an expired-cursor error. Same-document content edits do not refresh saved text. The cache holds at most eight snapshots / eight million code units; observations above four million fail explicitly, so narrow the read. Alternatively, use `find` with a specific `query` to search the full main-document accessibility tree, then `snapshot` with the chosen match's `ref` to read its subtree. Search results carry ancestor paths to distinguish same-name matches. Scope and budget do not reassign existing refs; iframe content is not included in this search.

Fall back to `evaluate` (JS) only when:
- The target has no `@e` ref in the snapshot
- You need attributes not in the snapshot (e.g., `href`)
- You need to dispatch complex event sequences, or scroll

## Evaluate Tips

- Always use compact `JSON.stringify(data)` — never add `null, 2` formatting. Indentation and newlines can inflate the response several times over, causing truncation during transmission.
- `evaluate` calls share the page's JS realm — re-declaring the same `const`/`let` across two calls throws `SyntaxError`. Wrap in an IIFE for a fresh scope: `(() => { const x = ...; return x; })()`.

## Text input — use `fill`

`fill` (selector = CSS or `@e` ref, plus the value) works on `<input>`/`<textarea>` (returns `mode: "value"`) and on `[contenteditable]` rich editors — ProseMirror, TipTap, Lexical, Slate, Quill, etc. (returns `mode: "contenteditable"`), firing the right input events so the page reacts.

`fill` is **clear-and-insert**: existing content is replaced. To append, read the current value via `evaluate`, concatenate, then `fill` with the result.

## Form submit / special keys

There's no separate "press Enter" tool. To submit a form, click the submit button directly (`click` on the @e ref or selector). To dispatch a key event programmatically (e.g. Escape to close a modal):

```bash
{"action":"evaluate","args":{"code":"document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"}}
```

## Save the current page as PDF

`save_as_pdf` renders the current page to PDF and returns the file path. All args optional:
- `paper_format`: `letter` (default) \| `a4` \| `legal` \| `a3` \| `tabloid`
- `landscape`: `false` (default)
- `scale`: `1.0` (default), range `[0.1, 2.0]`
- `print_background`: `true` (default) — keep background colors
- `path`: caller-supplied output path; if absent, daemon picks a default under OS temp dir using the page title as the filename

`path` semantics match `screenshot`: written verbatim, parent dirs auto-created, existing files overwritten.

Decoded PDF cap is 100 MB. Above that the daemon refuses; reduce `scale` or split the page.

## Known limitations

- **Sites that strictly check `event.isTrusted`** (some banking portals, captchas) ignore `click` / `fill` because those fire DOM-level synthetic events (`isTrusted=false`). For these, tell the user the page needs manual interaction. (Trusted input is possible at the protocol level via the `cdp` escape hatch, but treat that as advanced: your tabs are background tabs, and real input only reaches a background tab while focus emulation is on — send `Emulation.setFocusEmulationEnabled` `{"enabled":true}` before the input and `{"enabled":false}` when done with the tab. If input still does not land, `Page.bringToFront` is the last resort; see the `cdp` row.)
- **Content inside iframes**: `snapshot`, `fill`, `click` and `evaluate` see only the top document — an embedded document (preview pane, sandbox preview, embedded app) is a separate page and its nodes are not in the tree. When a snapshot lists `frames` after the tree (`frames: [{frame:"#f1", url, size, …}]`, biggest first), read one with `read_page` `{"frame":"#f1"}`, using a handle from that list. A frame read echoes `frame` in its result; if it does not, the extension is older than this skill and returned the top page instead — see Version mismatches below. A preview frame often appears many seconds after the page itself loads — `wait` `{"frame":"any"}` returns the moment one filling a large part of the screen is readable, instead of re-snapshotting. A PDF preview is read through the viewer's own document, so every page comes back without scrolling. Acting on elements inside a frame is still not supported — navigating to the frame's URL directly sometimes works, but an authenticated preview stream usually loads nothing on its own.

## If a tool call fails (daemon or extension not ready)

**If a tool call can't reach the daemon (connection refused), or the reply isn't the `ok` envelope above (another program is answering on that port), run `start` yourself, don't ask the user. It is safe anytime: it no-ops if the daemon is already up.** The binary is not on PATH: `~/.kimi-webbridge/bin/kimi-webbridge` (Windows: `%USERPROFILE%\.kimi-webbridge\bin\kimi-webbridge.exe`).

Where the daemon listens is always in `start`'s output, or in `kimi-webbridge status` (`port` when it is running, `addr` when it is not). If it isn't `127.0.0.1:10086`, use that address for every call in this task. The config file is only for moving the daemon, never for finding it. Then retry the tool call.

**If the reply is `ok:false` with code `extension_not_connected`**, the daemon is fine and the browser side isn't — `start` won't change that. The message names what the user has to do; relay it in their language and carry on once they confirm.

**`start` fails with "did not come up … held by another program"** → another program owns the port. Move the daemon: write `{"addr":"127.0.0.1:<port>"}` (a free port of your choice) to the config file the error names, run `start` again, then ask the user to point the extension at the new port once (Kimi side panel → Settings → Local agent remote control → Connection address → `ws://127.0.0.1:<port>/ws`; it remembers).

If it still fails, the binary is missing (`command not found` means kimi-webbridge isn't installed), or the browser extension won't connect — point the user to the help page instead of deep-troubleshooting:

- English: https://www.kimi.com/en/products/kimi-browser-extension
- 中文: https://www.kimi.com/products/kimi-browser-extension

Never run `stop` / `restart` / `upgrade` / `uninstall` automatically — those kill a running daemon. When `status` shows `version_mismatch`, `update_available` or `skill_mismatch`, or a `kimi-webbridge` command prints a `==> … Run: <command>` line (the same notices, on stderr), tell the user and hand them the command verbatim to run — the `command` field, or what follows `Run:`; that is what it is for. When the user asks about kimi-webbridge itself (install, start/stop/upgrade, "is it running", what `status` means, moving it to another port), read `references/operations.md` first.

## Version mismatches

If a tool returns an error containing **"Please update the Kimi Browser Extension"**, the user's browser extension is older than this skill. Don't try to reconcile versions yourself — just tell the user, in their language, to update the extension and retry:

- English: https://www.kimi.com/en/products/kimi-browser-extension
- 中文: https://www.kimi.com/products/kimi-browser-extension
