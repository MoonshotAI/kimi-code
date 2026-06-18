/**
 * English translations for slash commands.
 *
 * `commands.descriptions.<name>` holds the palette/autocomplete description for
 * each builtin command; `commands.args.<command>.<sub>` holds argument-
 * autocomplete descriptions; `commands.help.*` holds the `/help` panel chrome.
 * Command names / identifiers themselves are never translated — only the
 * human-readable text lives here. Keep keys stable: they are the
 * contributor-facing contract shared with every locale.
 */

import type { MessageTree } from '../../i18n';

export const commands: MessageTree = {
  descriptions: {
    yolo: 'Toggle auto-approve mode',
    auto: 'Toggle auto permission mode',
    permission: 'Select permission mode',
    settings: 'Open TUI settings',
    plan: 'Toggle plan mode',
    swarm: 'Toggle swarm mode or run one task in swarm mode',
    model: 'Switch LLM model',
    provider: 'Manage AI providers (add / delete / refresh)',
    btw: 'Ask a forked side agent a question',
    help: 'Show available commands and shortcuts',
    new: 'Start a fresh session in the current workspace',
    sessions: 'Browse and resume sessions',
    tasks: 'Browse background tasks',
    mcp: 'Show MCP server status',
    plugins: 'Manage plugins',
    experiments: 'Manage experimental features',
    reload: 'Reload session and apply config.toml settings plus tui.toml UI preferences',
    'reload-tui': 'Reload only tui.toml UI preferences',
    compact: 'Compact the conversation context',
    goal: 'Start or manage an autonomous goal',
    init: 'Analyze the codebase and generate AGENTS.md',
    fork: 'Fork the current session',
    title: 'Set or show session title',
    usage: 'Show session tokens + context window + plan quotas',
    status: 'Show current session and runtime status',
    feedback: 'Send feedback to make Kimi Code better',
    undo: 'Withdraw the last prompt from the transcript',
    editor: 'Set the external editor for Ctrl-G',
    theme: 'Set the terminal UI theme',
    logout: 'Log out of a configured provider',
    login: 'Select a platform and authenticate',
    'export-md': 'Export current session as a Markdown file',
    'export-debug-zip': 'Export current session as a debug ZIP archive',
    web: 'Open the current session in the Web UI and exit the terminal',
    exit: 'Exit the application',
    version: 'Show version information',
  },
  args: {
    goal: {
      status: 'Show the current goal',
      pause: 'Pause the active goal',
      resume: 'Resume a paused goal',
      cancel: 'Cancel and remove the current goal',
      replace: 'Replace the current goal with a new objective',
      next: 'Queue an upcoming goal',
      manage: 'Manage upcoming goals',
    },
    swarm: {
      on: 'Turn swarm mode on',
      off: 'Turn swarm mode off',
    },
  },
  help: {
    title: 'help',
    dismiss: '· Esc / Enter / q to cancel · ↑↓ scroll',
    showing: 'showing {start}-{end} of {total}',
    greeting: 'Sure, Kimi is ready to help! Just send a message to get started.',
    keyboardShortcuts: 'Keyboard shortcuts',
    slashCommands: 'Slash commands',
    shortcuts: {
      planMode: 'Toggle plan mode',
      externalEditor: 'Edit in external editor ($VISUAL / $EDITOR)',
      toolOutput: 'Toggle tool output expansion',
      steer: 'Steer — inject a follow-up during streaming',
      newline: 'Insert newline',
      interrupt: 'Interrupt stream / clear input',
      exit: 'Exit (on empty input)',
      closeDialogs: 'Close dialogs / interrupt streaming',
      history: 'Browse input history',
      submit: 'Submit',
    },
  },
};
