export default {
  // Switcher
  switcherTitle: 'Switch workspace',
  switchTooltip: 'Switch workspace',
  eyebrow: 'Workspace',
  branchLabel: 'branch: {branch}',
  noBranch: 'no branch',
  sessionCount: '{count} session | {count} sessions',
  allWorkspaces: 'All workspaces',
  currentWorkspace: 'Current workspace only',
  addWorkspace: 'Add workspace…',
  noWorkspace: 'No workspace',
  deleteHasSessions: 'This workspace still has sessions — archive them before deleting it',
  // Column-header scope toggle
  scopeCurrent: 'this workspace',
  scopeAll: 'all workspaces',
  // Group headers (all-workspaces scope)
  newInGroup: 'New session in this workspace',
  // Add-workspace dialog
  addTitle: 'Add workspace',
  pathLabel: 'Path',
  pathPlaceholder: '/absolute/path/to/project',
  recentLabel: 'Recent folders',
  add: 'Add',
  cancel: 'Cancel',
  addHint: 'Paste an absolute folder path, or pick a recent one.',
  // Folder browser
  openThisFolder: 'Open this folder',
  up: 'Up',
  browsing: 'Browsing…',
  filterPlaceholder: 'Filter subfolders…',
  searchPlaceholder: 'Fuzzy-search under this folder…',
  searching: 'Searching…',
  pasteToggle: 'Enter an absolute path',
  noFilterMatch: 'No subfolders match “{q}”',
  noSubfolders: 'No subfolders here',
  gitTag: 'git',
  browseHint: 'Click a folder to enter it, then "Open this folder" to add it as a workspace.',
  // Attention marker
  attentionTitle: '{count} item needs your attention | {count} items need your attention',
  // Per-session pending tags (sidebar)
  awaitingAnswer: 'Answer',
  awaitingAnswerTitle: 'A question is waiting for your answer',
  awaitingPermission: 'Approve',
  awaitingPermissionTitle: 'An action is waiting for your approval',
  aborted: 'Stopped',
  abortedTitle: 'This session was interrupted before finishing',
} as const;
