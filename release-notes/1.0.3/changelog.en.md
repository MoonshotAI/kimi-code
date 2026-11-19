### Features

- Local HTML files in chat now open as real pages in the built-in browser.
- Downloads can now be paused, resumed, canceled, and retried, with speed and time left shown.
- Added a settings toggle for automatic session title generation.
- Right-click file names in chat to copy paths or reveal them in folders.
- Valid leading slash commands are highlighted in the input, with argument hints shown.

### Polish

- Markdown tables in chat now have a rounded frame and expand to full width.
- Cron jobs now show readable names, schedules, and details in conversations.

### Bug Fixes

- Fixed a vulnerability letting malicious web pages run commands through the local embedded server.
- Fixed long conversations freezing on open, stuttering while streaming, and overusing memory on mobile.
- Fixed the confirmation dialog spinning forever after deleting a session.
- Fixed the subagent model showing as unconfigured in settings and not taking effect when saved.
- Fixed a series of display issues with Swarm cards and member statuses.
- Fixed forked sessions having their titles overwritten by automatic regeneration.
- Fixed terminal Cmd+K opening the search panel and Ctrl+C not copying selection.
