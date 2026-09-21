---
name: kimi-cu
description: |
  Control local Windows desktop apps. Use this skill when a user asks to inspect,
  screenshot, click, type, scroll, drag, or otherwise operate a real Windows GUI
  app. The tool shape is close to KimiCU macOS, while Windows operations prefer
  screenshot state plus real Win32 input for web/Electron apps and use UIA mainly
  for observation or native-control optimizations.
---

# kimi-cu for Windows

This plugin mirrors the KimiCU macOS usage model where it fits Windows. The
plugin is a thin shell that starts the installed native runtime:

```text
%LOCALAPPDATA%\KimiCU\kimi-cu.exe mcp
```

## Runtime Installation

The harness may expose either PowerShell or Bash on Windows. Use the matching
syntax below; do not pass PowerShell expressions directly to Bash.

If the MCP wrapper reports that the runtime is missing, check it in PowerShell:

```powershell
Test-Path "$env:LOCALAPPDATA\KimiCU\kimi-cu.exe"
```

Or in Bash:

```bash
if [ -f "$LOCALAPPDATA/KimiCU/kimi-cu.exe" ]; then echo True; else echo False; fi
```

If the result is `False`, tell the user that KimiCU is not installed. If the
current request explicitly asks to install KimiCU, proceed without asking
again; otherwise obtain confirmation before running the official installer.
In PowerShell, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Invoke-RestMethod 'https://cdn.kimi.com/kimi-computer-use-windows/latest/setup_windows.ps1' | Invoke-Expression"
```

In Bash, use the CMD bootstrap so Windows PowerShell does not need to be on
`PATH`:

```bash
setup_cmd="$(mktemp -t kimi-cu-setup-XXXXXX.cmd)"; trap 'rm -f "$setup_cmd"' EXIT; curl -fsSL https://cdn.kimi.com/kimi-computer-use-windows/latest/setup_windows.cmd -o "$setup_cmd" && "$setup_cmd"
```

Then verify it in PowerShell:

```powershell
& "$env:LOCALAPPDATA\KimiCU\kimi-cu.exe" doctor
```

Or in Bash:

```bash
"$LOCALAPPDATA/KimiCU/kimi-cu.exe" doctor
```

Use the same shell-specific runtime command with `doctor` replaced by
`install-agent` or `start-agent` when troubleshooting requires it.

## Workflow

1. Use `list_apps` to find the target app and window. To start an app first,
   call `launch_app(app)`, where `app` is an executable path/name such as
   `notepad.exe` or `D:\path\app.exe`, an exact Windows StartApps display name
   such as `飞书`, or a StartApps AppID such as `kugou`. Unknown or ambiguous
   StartApps names fail without opening Explorer. If launch succeeds, call
   `list_apps` again and pick the visible target window.
2. Use `get_app_state` before acting. It observes without activating or focusing
   the target. Use `mode:"full"` for the first
   observation or when you need both visual layout and UIA indexes. Use
   `mode:"image"` when coordinates/visual inspection are enough and the UIA tree
   would only add noise. Use `mode:"ax"` when the screenshot is already known
   and you need the full UIA tree, indexes, roles, focused element, or native
   control structure. Use `mode:"text"` when you only need compact visible text
   without screenshot image content; it returns `visible_text` with text lines,
   indexes, rects, `filter`, `max_chars`, and truncation metadata. Avoid
   repeated `mode:"full"` calls in long tasks unless both screenshot and UIA
   changed. Only these four modes are valid; `mode:"all"` is not accepted.
3. Target `get_app_state` with `pid`, `app`, or `window_id`. It returns a
   `snapshot_id`; pass that `snapshot_id` to later mutating tools so they act on
   the same observed window and reject stale window geometry. A `snapshot_id`
   does not prove that the visual content or accessibility indexes are still
   current.
   After a dialog opens or the active app window changes, call `get_app_state`
   with `app` or `pid` instead of reusing the previous `window_id`. A
   `window_id` always targets that exact window and never follows dialogs. If
   the returned `windows` list contains the intended dialog, call
   `get_app_state` with that dialog's `id` as `window_id` before acting.
   Prefer `mode:"text"` after scrolling in Electron/Web apps or message history
   views when you are only checking whether target text is present.
4. Prefer element `index` when the element is reliable. Use screenshot
   coordinates when the UIA tree is incomplete or misleading.
   For tools that accept either `index` or coordinates, pass exactly one target
   shape: `index`, or both `x` and `y`. Do not mix `index` with `x`/`y`.
5. Batch related actions against the same snapshot while the window and intended
   target remain stable, such as focusing a text box, typing, and submitting.
   Do not re-observe between every input. Call `get_app_state` again before using
   old indexes or coordinates after navigation, tab or modal changes, list
   refreshes, scrolling, or dragging. Re-observe whenever focus or the result is
   uncertain, before sensitive actions, and after important actions to verify
   the result.

The state response includes `snapshot_id`. It validates the target window and
its screenshot coordinate system, not the freshness of the window's visual or
semantic content. If the window moved, resized, or changed process, mutating
tools reject the stale `snapshot_id` and ask for a fresh state. The runtime
cannot automatically detect content-only changes such as button reordering, so
the workflow boundaries above determine when to re-observe.

## Backend Meaning

Mutating tools return `used_backend` where practical:

- `foreground_click`, `foreground_wheel`: the helper activated the window and
  used real mouse input.
- `foreground_clipboard_paste`: text was pasted with the Windows clipboard and
  `Ctrl+V`. This overwrites the system clipboard and intentionally leaves the
  input text there because Windows does not acknowledge when a paste consumer
  has finished reading it.
- `foreground_ctrl_a`: text selection used real focus plus `Ctrl+A`.
- `uia_value`, `uia_legacy_value`, `uia_range_value`: a native UIA value pattern
  was used.
- `uia_invoke`, `uia_toggle`, `uia_expand`, `uia_collapse`,
  `uia_selection_select`, `uia_scroll_pattern`, `uia_scroll_item`: a native UIA
  action pattern was used.

For Electron, web views, Feishu/Lark, Chrome, rich text editors, and chat boxes,
expect `foreground_*`. UIA is useful for observing names, values, roles, and
rectangles, but it is not the primary write/click path for web frontends.

## Tool Preferences

- Text editors and chat boxes: use `type_text(snapshot_id, text, index)` or
  `type_text(snapshot_id, text, x, y)`. It focuses the target, optionally handles `clear` with
  `Ctrl+A`/Backspace, and pastes text. An index must come from the latest tree or
  visible-text lines; `focused_element` is diagnostic text and does not provide
  an actionable index. Non-editable indexes are rejected before clearing.
  For coordinate targets where UIA exposes only a covering `Document`, `Group`,
  `Pane`, or `Custom` surface (or no focused element), use only `clear:false`
  and `submit:false`; the runtime can dispatch the paste but returns
  `verification.status=unavailable`, so call `get_app_state` and verify the
  visible result. Explicit controls such as buttons, menus, and lists remain
  rejected as text targets.
  Check the returned `verification` and dispatch fields: `matched` means UIA
  confirmed the text. When `submit:true` is requested, Enter is sent only for a
  matched input; otherwise `submitted` is false with `submit_skip_reason`.
  `unavailable` means the paste path ran but the text was not confirmed. Observe
  the field before deciding whether to submit separately.
- Clicks: use `click(snapshot_id, index)` or `click(snapshot_id, x, y)`.
  Both forms use real mouse input. `index` is only used to resolve a target
  from the latest accessibility tree; it is not a request to perform UIA
  Invoke. UIA rects and index input share the same normalized geometry,
  including correction for detected embedded providers that duplicate the
  window DPI scale. A successful response confirms dispatch, not the
  application's resulting state, so re-observe after important clicks. Do not
  pass `index` and `x`/`y` together.
- Chromium/Electron combo boxes: transient option clicks may be dispatched
  without changing the selected value. Focus the combo box, use
  `Home`/`End`/`Up`/`Down` to choose an option, press `Enter`, then re-observe
  and verify the value. Use `perform_secondary_action(..., "select")` only
  when the option exposes a real UIA SelectionItem pattern.
- Text selection: use `select_text(snapshot_id, index)` or coordinates.
  Web/Electron targets use real focus plus `Ctrl+A`; native controls may use
  UIA TextPattern. Do not pass `index` and `x`/`y` together.
- Native forms/sliders: use `set_value(snapshot_id, index, value)` only for
  controls that genuinely expose UIA Value/RangeValue.
- Native secondary actions: use `perform_secondary_action(snapshot_id, index, action)` only
  when the indexed native control exposes a real UIA semantic pattern, such as
  `invoke`, `expand`, `collapse`, `toggle`, `select`, or `scroll_into_view`.
  It is not a general click or scroll fallback. If it reports no supported UIA
  action, use `click`, `scroll`, or `press_key` based on the current screenshot.
- Scrolling: use `scroll(snapshot_id, index, dy)` or
  `scroll(snapshot_id, x, y, dy)`.
  `dy > 0` scrolls up, `dy < 0` scrolls down, and `dx > 0` scrolls right.
  Do not pass `index` and `x`/`y` together.
- Scrolling, dragging, and key presses use real `SendInput`. `press_key` accepts
  `keys`, including forms such as `Enter`, `Control_L+a`, `CTRLV`,
  `F5`, `PageDown`, and `Insert`. Direction keys accept either
  `Left`/`Right`/`Up`/`Down` or `ArrowLeft`/`ArrowRight`/`ArrowUp`/`ArrowDown`.
  Punctuation keys include `equal`, `minus`, `comma`, `period`, `semicolon`,
  `slash`, `backslash`, `grave`, `bracketleft`, `bracketright`, and `apostrophe`.
  They address physical OEM keys using the current keyboard layout/IME; Shift is
  never added implicitly. On a US layout, `equal` types `=` and `Shift_L+equal`
  types `+`. `plus`/`add`/`KP_Add`/`numpad_add` sends keypad `+`.
  Literal `+` is reserved as the chord separator; use a named key instead.

Windows real input may briefly move the physical pointer. The runtime restores
the pointer afterward and shows a click-through second-cursor overlay so the
model/user can see what is being operated. Call `turn_ended` to hide the overlay
at the end of a turn if needed.

If an input tool returns `code=computer_use_busy`, another session currently
owns real input. Read-only observation remains available; refresh state and
retry the input later. Do not bypass the ownership guard with shell commands.

## Safety

- Do not automate protected windows such as terminals, the Codex app process,
  password managers, security prompts, or system permission dialogs. Browser
  pages with `codex` in the title are not protected by title alone.
- Do not use Windows/Meta/Super/Command key chords.
- A clear current-turn request that names the action and target counts as user
  confirmation; do not ask again. For irreversible or external actions such as
  sending, deleting, submitting, uploading, installing, or changing
  permissions, ask immediately before execution only when the action was not
  explicitly requested, its target or scope is ambiguous, or the plan changed.
- If a screenshot contains unrelated private information, only use the part
  required for the user's requested action.

## Troubleshooting

If the runtime exists but MCP still fails, run `doctor` with the matching
PowerShell or Bash command from **Runtime Installation**.

- Runtime missing: follow **Runtime Installation** above.
- If `doctor` reports automatic agent startup missing, run `install-agent` with
  the matching command.
- If `doctor` reports the agent stopped, run `start-agent` with the matching
  command.
- Agent startup, capture, or input still unavailable: report possible Windows
  policy or non-interactive-session restrictions instead of claiming success.

If a target element index fails after the UI changed, call `get_app_state`
again and use the new index or coordinates.

If screenshot capture fails on a minimized window, call `activate_window` with
the same target, then call `get_app_state` again once. If the window handle
became stale, call `list_apps` and select the current window before retrying.
Use `activate_window` otherwise only when the task explicitly requires bringing
an existing window to the foreground; input tools activate their target
automatically.
