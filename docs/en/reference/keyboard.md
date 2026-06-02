# Keyboard shortcuts

The TUI interactive mode of Kimi Code CLI supports the keyboard shortcuts listed below. These keys primarily take effect inside the input box; some have different behavior inside popups (such as the `/help` panel or the approval panel) or during streaming output.

Type `/help` at any time inside the TUI to open the built-in shortcut list.

## General shortcuts

The following keys are always available in the input box:

| Shortcut | Action |
| --- | --- |
| `Enter` | Submit the current input |
| `Shift-Enter` / `Ctrl-J` | Insert a newline in the input |
| `↑` / `↓` | Browse input history |
| `Esc` | Close popup / cancel completion / interrupt streaming output or an in-progress context compaction |
| `Ctrl-C` | Interrupt the current streaming output, or clear the input box |
| `Ctrl-D` | Exit Kimi Code CLI when the input box is empty |

Pressing `Ctrl-C` **during streaming output** cancels immediately with no second confirmation needed.

**Exiting the program** (pressing `Ctrl-C` when the input box is empty, or pressing `Ctrl-D`) uses a "double-press to confirm" mechanism: the first press shows a hint in the status bar (for example, `Press Ctrl+C again to exit`), and only a second press of the same key actually exits. Pressing any other key in between clears the confirmation state.

## Mode switching

| Shortcut | Action |
| --- | --- |
| `Shift-Tab` | Toggle Plan mode |

Press `Shift-Tab` to turn Plan mode on or off. While Plan mode is on, the agent favors read-only tools for research and planning and can write the current plan file; when needed, it can also call `Bash`, which follows the current permission mode and ordinary rules without triggering an extra independent approval just because Plan mode is active. Toggling the mode alone does not create an empty plan file. Press `Shift-Tab` again to leave Plan mode.

## Input and editing

| Shortcut | Action |
| --- | --- |
| `Ctrl-G` | Edit the current input in an external editor |
| `Ctrl-V` | Paste an image or video from the clipboard (Unix / macOS) |
| `Alt-V` | Paste an image or video from the clipboard (Windows) |
| `Ctrl-E` | Expand or collapse the Plan card (when no Plan card is present, follows the system default behavior of moving the cursor to the end of the line) |
| `Ctrl--` | Undo |

Pressing `Ctrl-G` opens an external editor to edit the current input. The editor is chosen in the following order of priority:

1. The editor configured by the `/editor` command
2. The `$VISUAL` environment variable
3. The `$EDITOR` environment variable

After saving and exiting the editor, the edited content replaces the input box contents; exiting without saving leaves the input unchanged.

When pasting an image or video, it appears in the input box as a placeholder, and the actual media data is sent to the model together with the message on submit. The preferred source is an image or file path on the system clipboard; on Linux, both Wayland and X11 are tried, and on WSL the Windows clipboard is also read via PowerShell as a fallback.

## During streaming output

While output is streaming, the input box still accepts input and supports the following extra actions:

| Shortcut | Action |
| --- | --- |
| `Ctrl-S` | Steer: inject the current input into the running turn immediately |
| `Esc` | Interrupt the current streaming output |
| `Ctrl-C` | Interrupt the current streaming output |

When you press `Ctrl-S`, the model sees your message at the next interruptible point, without waiting for the current turn to finish.

## Tool output

| Shortcut | Action |
| --- | --- |
| `Ctrl-O` | Expand or collapse tool output |

When collapsed tool call results are present in the history, press `Ctrl-O` to toggle between collapsed and expanded views to inspect the full tool output.

## Approval panel

When the agent issues a tool call that requires confirmation, the TUI shows an approval panel. For the full approval flow, see [Interaction and Input](../guides/interaction.md#approval-flow); the table below lists the keys available inside the panel:

| Shortcut | Action |
| --- | --- |
| `↑` / `↓` | Move the cursor between options |
| `Enter` | Confirm the currently selected option |
| `1` ~ `9` | Directly select the option with the matching number |
| `Esc` / `Ctrl-C` / `Ctrl-D` | Reject the current request |
| `Ctrl-E` | Expand or collapse the full content when the panel includes a diff or file preview |
| `Ctrl-O` | Toggle the collapsed state of other tool output |

Options that require additional feedback (such as "Reject" or "Revise") switch to a feedback input state after confirmation: type the feedback text directly and press `Enter` to submit, or press `Esc` to exit the feedback input and return to the option list.

## Popup mode

After typing `/help` to open the help panel, the following keys are available to navigate and close the panel:

| Shortcut | Action |
| --- | --- |
| `↑` / `↓` | Scroll one line |
| `PageUp` / `PageDown` | Scroll 10 lines |
| `Esc` | Close the panel |
| `Enter` | Close the panel |
| `q` / `Q` | Close the panel |
