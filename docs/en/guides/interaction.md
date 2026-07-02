# Interaction and input

Kimi Code CLI runs as an interactive TUI (terminal user interface) built around three components: the input box, the conversation view, and the status bar. This page covers how to enter text, paste media, navigate the approval flow, and switch between modes.

## Input box basics

The input box accepts free-form text. Press `Enter` to send, or `Shift-Enter` / `Ctrl-J` to insert a newline. When the input box is empty, press `↑` / `↓` to browse the input history for the current working directory, including previous shell commands.

**Exiting the CLI**: press `Ctrl-D` with the input box empty, press `Ctrl-C` twice while idle, or type `/exit`. Pressing `Ctrl-C` or `Esc` during streaming output interrupts the current turn — it does not exit the program.

## Pasting images and video

Kimi Code CLI supports pasting images and video directly into the input box, so you can discuss screenshots, UI mockups, architecture diagrams, or code demos without uploading or converting files first.

**Video input is a distinctive Kimi Code capability** — you can paste a video clip and have the model analyze its content, UI flow, or code walkthrough.

How to paste:

- **macOS / Linux**: `Ctrl-V`
- **Windows**: `Alt-V`

After pasting, the input box shows a placeholder that you can edit like normal text; on submit, the placeholder is replaced with the actual content. A plain-text clipboard falls back to ordinary paste. Media support depends on the current model's multimodal capabilities (`image_in` / `video_in`); it is enabled by default when you are logged in to a Kimi Code account.

## Slash commands

Anything starting with `/` is treated as a slash command. Typing `/` opens a completion menu that filters in real time as you keep typing; press `Esc` to close the menu. If nothing matches, the input is sent to the agent as a regular message.

Active [Agent Skills](../customization/skills.md) are automatically registered as slash commands: ordinary external Skills are invoked with `/skill:<name>`, external sub-skills appear as dotted commands such as `/parent.child`, and built-in Skills appear directly as `/<name>` in the slash command panel. If an external skill name does not conflict with a system slash command, you can also drop the `skill:` prefix and type `/<name>` directly.

Some commands are only available when the agent is idle — you need to press `Esc` to interrupt streaming output or context compression before using them. Mode-toggle and query commands like `/yolo`, `/plan`, `/help`, and `/btw` are always available. For the full list, see [Slash commands reference](../reference/slash-commands.md).

## File references

Type `@` to trigger file-path completion. Selecting a path inserts its relative form into your message; the agent loads the file content directly when it reads the message. File references work in both git and non-git directories, and folder suggestions end with `/` so you can keep completing paths inside them. If the fast search helper is still downloading, Kimi Code falls back to a basic filesystem scan. Hidden paths are available, but `.git` is excluded from suggestions.

> `@` references and slash commands are two separate mechanisms: `@` gives the agent file context, while `/` invokes built-in features or Skills. A `/` typed after leading whitespace is treated as normal text, not as the slash-command menu.

## Approval flow

When the agent calls a tool that has side effects — modifying files, running commands — the TUI displays an approval panel for your confirmation. Approvals are not triggered in YOLO mode, nor for writes to plan files in Plan mode.

Use the arrow keys to select an option and press `Enter` to confirm, or press `1` / `2` / `3` to select by number directly. `Esc`, `Ctrl-C`, and `Ctrl-D` are all equivalent to rejecting.

The panel typically includes an **Approve for this session** option; selecting it auto-approves the same kind of call for the rest of the session. For permanent rules, add allow / deny entries in [Configuration files](../configuration/config-files.md#permission).

## Mode switching

### Plan mode

In Plan mode the agent first outputs an action plan and waits for your approval before modifying any files — useful for complex or high-risk tasks.

- Toggle: `Shift-Tab` or `/plan`
- Clear the current plan: `/plan clear` (only while idle)

After producing a plan the agent pauses for your review — you can approve it, reject it, or ask for revisions. Exiting Plan mode always requires your confirmation, even if YOLO mode is also active.

### YOLO / Auto mode

**YOLO mode** (`/yolo`) skips the approval confirmation for almost all tool calls, making it suitable for batch tasks you know are safe. The one exception is the exit-confirmation for Plan mode.

**Auto mode** (`/auto`) is more restrained: tool approvals are handled automatically, but the agent does not ask the user clarifying questions — useful when you want unattended operation without fully disabling approvals.

::: warning
YOLO mode skips confirmation for file writes and command execution. Only use it in working directories you trust.
:::

### Shell mode

Shell mode lets you run terminal commands without leaving the conversation. The command output is written into the conversation context, so the agent can see the results in later turns.

- Enter: type `!` in an empty input box, or paste a command that starts with `!`.
- Exit: press `Backspace` or `Esc` in an empty input box; submitting a command also returns you to normal mode automatically.
- Run in background: while a command is running, press `Ctrl+B` to move it to a background task.
- Recall previous commands: with the input box empty in shell mode, press `↑` to browse earlier shell commands; recalling one keeps you in shell mode so it runs as a command again.

In shell mode the input box shows a `!` prompt on the left and the border turns violet. For example, you can run `!gh auth login` to sign in to the GitHub CLI without opening a new terminal, so Kimi can use `gh` afterward.

## During streaming output

The input box remains usable while the agent is thinking or calling tools, and supports the following extra actions:

- **`Ctrl-S`**: inject the content in the input box into the running turn immediately, without waiting for it to finish
- **`Esc` / `Ctrl-C`**: interrupt the current turn
- **`Ctrl-O`**: globally toggle the collapsed/expanded state of tool output

## External editor

Press `Ctrl-G` to send the current input content to an external editor. When you save and close, the text is written back into the input box; if you close without saving, the original content is preserved. This is handy when you need to enter large blocks of text or content with complex formatting.

Editor priority: `/editor` config → `$VISUAL` environment variable → `$EDITOR` environment variable. If none are set, run `/editor` first to choose a default.

## Next steps

- [Keyboard shortcuts](../reference/keyboard.md) — full quick-reference table of all shortcuts
- [Slash commands](../reference/slash-commands.md) — all built-in commands with descriptions and aliases
- [Sessions and context](./sessions.md) — how to resume sessions, compress context, and export conversations
