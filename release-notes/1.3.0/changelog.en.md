### Features

- Create projects and add multiple working directories to a project.
- A new right panel shows session details in one place.
- Diagnostic export now packages logs and crash reports for troubleshooting.
- Fork sessions from any historical turn, including while running.
- Running subagents can now control the built-in browser with your permission.
- Desktop can open Markdown documents with your default system application.
- The file tree can now expand symbolic-link directories.

### Polish

- Improved plugin marketplace UI and interactions.
- The interface, code, and terminal now use system fonts.
- The conversation outline moves left, with improved UI and interactions.
- Computer-use and tool-selection calls now show readable titles, parameters, and result summaries.
- Background questions collapse while pending, then expand with their answers.
- The task panel focuses on running jobs and accumulates detailed output live.
- Subagent model settings now include a Follow default model option.
- Queued messages now use the session's current permission mode.
- Startup now shows a loading page with diagnostic export and restart actions.
- Session details now start collapsed in the right panel and can be expanded manually.

### Bug Fixes

- Fixed startup failures, blocking error dialogs, and black screens after renderer crashes.
- Fixed Windows preventing the computer from sleeping while running in the background.
- Fixed screenshot capture failing on some Windows computers.
- Fixed multiple Windows path display and model-recognition issues.
- Fixed duplicate Windows attachment actions and occasional crashes when exiting terminals.
- Fixed approval feedback, entered content, and multi-step answers occasionally resetting.
- Fixed long-session history pagination stopping, jumping, reloading, and timing out.
- Fixed freezing and persistent stuttering in long sessions and streaming replies.
- Fixed folded answers and stopped live updates after background continuation or session switching.
- Fixed side-chat first replies mixing with the main session and missing or reordered history.
- Fixed blank panels, stuttering, stale refreshes, and misplaced latest-message buttons in the right panel.
- Fixed typing lag after large pastes and pasted image links being treated as local files.
- Fixed line-numbered file references not opening and slash menus changing selection unexpectedly.
- Fixed header copy actions and errors when opening external links or saving screenshots.
- Fixed subagents still falling back to the main model despite a configured subagent model.
- Fixed custom registry import and refresh errors, plus stale MCP tool lists.
- Fixed update error dialogs appearing after sleep or network changes.
- Fixed rendering errors and crashes involving images, inline math, and device emulation.
- Fixed root switching, file previews, and duplicate-directory errors in multi-directory projects.
- Fixed Esc not closing Settings and UI controls misbehaving during streaming output.
- Fixed narrow-window layouts and clipped buttons in remote-control conflict dialogs.
- Fixed todo lists not rolling back after undoing messages.

### Other

- macOS 13 is now required; macOS 12 no longer receives updates.
