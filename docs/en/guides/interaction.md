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

Type `/` to open the completion menu — it filters as you type, `Esc` closes it, and unmatched input goes to the agent as a regular message. Common commands:

| Command | Action |
| --- | --- |
| `/new` | Start a new session |
| `/sessions` | Browse and resume past sessions |
| `/compact` | Compact the current session's context |
| `/undo` | Undo recent prompts |
| `/model` | Switch the model used in the current session |
| `/plan` | Toggle Plan mode (plan first, then execute) |
| `/yolo` | Toggle YOLO mode (auto-approve regular tool calls) |
| `/goal` | Start or manage goal mode |
| `/help` | Show all commands |

Active [Agent Skills](../customization/skills.md) are also registered as slash commands (e.g. `/skill:<name>`). For the full list, see [Slash commands reference](../reference/slash-commands.md).

## File references

Type `@` to trigger file-path completion; the selected path is inserted in relative form, and the agent loads the file content directly when it reads your message.

- **Where it works**: both git and non-git directories; hidden paths are included, `.git` is excluded
- **Folder suggestions**: end with `/`, so you can keep completing paths inside them
- **Fallback**: while the fast search helper is still downloading, Kimi Code falls back to a basic filesystem scan

> `@` references and slash commands are two separate mechanisms: `@` gives the agent file context, while `/` invokes built-in features or Skills.

## Approval flow

When the agent calls a tool that has side effects — modifying files, running commands — the TUI displays an approval panel for your confirmation.

- **Approve**: select with the arrow keys and press `Enter`, or press `1` / `2` / `3` to choose directly
- **Reject**: `Esc`, `Ctrl-C`, or `Ctrl-D`
- **Approve for this session**: auto-approves the same kind of call for the rest of the session
- **Permanent rules**: add allow / deny entries in [Configuration files](../configuration/config-files.md#permission)

Approvals are not triggered for regular tool calls in YOLO mode, nor for writes to plan files in Plan mode.

### YOLO / Auto mode

**YOLO mode** (`/yolo`) auto-approves regular tool calls, making it suitable for batch tasks you know are safe. It still asks before sensitive actions — accessing sensitive files such as `.env` or SSH keys, or exiting Plan mode — and the agent can still ask you questions.

**Auto mode** (`/auto`) is the fully unattended mode: every tool approval is handled automatically, including sensitive files and plan exits, and the agent never asks you questions — it decides everything on its own.


## Mode switching

### Plan mode

In Plan mode the agent first outputs an action plan and waits for your approval before modifying any files — useful for complex or high-risk tasks.

- Toggle: `Shift-Tab` or `/plan`
- Clear the current plan: `/plan clear` (only while idle)

After producing a plan the agent pauses for your review — you can approve it, reject it, or ask for revisions. Exiting Plan mode requires your confirmation even if YOLO mode is also active. Auto mode is the exception: plan exits are approved automatically and marked as "Auto-approved" in the transcript.

### Shell mode

Shell mode lets you run terminal commands without leaving the conversation. The command output is written into the conversation context, so the agent can see the results in later turns.

- Enter: type `!` in an empty input box, or paste a command that starts with `!`.
- Exit: press `Backspace` or `Esc` in an empty input box; submitting a command also returns you to normal mode automatically.
- Run in background: while a command is running, press `Ctrl+B` to move it to a background task.
- Recall previous commands: with the input box empty in shell mode, press `↑` to browse earlier shell commands; recalling one keeps you in shell mode so it runs as a command again.
- Long output: when a finished command's output is too long, the output card collapses automatically; press `Ctrl-O` to expand or collapse it together with tool output.

In shell mode the input box shows a `!` prompt on the left and the border turns violet. For example, you can run `!gh auth login` to sign in to the GitHub CLI without opening a new terminal, so Kimi can use `gh` afterward.

### Goal mode

A goal keeps the agent working toward a defined outcome across turns — a normal prompt says what to do next, a goal says what must become true. Use `/goal` for tasks with a clear finish line and verifiable evidence, like fixing a batch of failing tests.

Write the objective after `/goal`, naming the finish line and the stop condition:

```sh
/goal Fix every checkout-regression bug, add or update tests for each fix, then run the checkout test suite
```

Avoid broad objectives like `/goal find every bug in this codebase` — with no success criteria, the agent may block immediately or work far longer than expected.

Common management commands:

| Command | Action |
| --- | --- |
| `/goal` or `/goal status` | Show the current goal and its progress |
| `/goal pause` / `/goal resume` | Pause / resume the goal |
| `/goal cancel` | Cancel the goal |
| `/goal replace <objective>` | Replace the current goal |
| `/goal next <objective>` | Queue a follow-up goal that starts when the current one completes |

A goal stops in three ways: **complete** — achieved, cleared, and summarized; **paused** — you paused it, interrupted a turn, or an error occurred; **blocked** — the agent can't continue as stated and writes a short message explaining why. In the web UI, the goal bar below the conversation lets you pause, resume, or cancel the goal directly.

> Tip: in `manual` permission mode a goal may stop at tool approvals; non-interactive mode only supports creating goals (`kimi -p "/goal ..."`) — exit code `0` on complete, `3` on blocked, `6` on paused.

## During streaming output

The input box remains usable while the agent is thinking or calling tools, and supports the following extra actions:

- **`Ctrl-S`**: inject the content in the input box into the running turn immediately, without waiting for it to finish
- **`Esc` / `Ctrl-C`**: interrupt the current turn
- **`Ctrl-O`**: globally toggle the collapsed/expanded state of tool output and compaction summaries

## External editor

Press `Ctrl-G` to send the current input content to an external editor. When you save and close, the text is written back into the input box; if you close without saving, the original content is preserved. This is handy when you need to enter large blocks of text or content with complex formatting.

Editor priority: `/editor` config → `$VISUAL` environment variable → `$EDITOR` environment variable. If none are set, run `/editor` first to choose a default.

## Next steps

- [Keyboard shortcuts](../reference/keyboard.md) — full quick-reference table of all shortcuts
- [Slash commands](../reference/slash-commands.md) — all built-in commands with descriptions and aliases
- [Sessions and context](./sessions.md) — how to resume sessions, compress context, and export conversations
