// Session admin page (/admin/sessions) — the cross-workspace management view
// opened from the sidebar's list-options menu. Keyed by page region so later
// phases extend without reshuffling:
//   title/subtitle  page head
//   filter bar      filter* / allWorkspaces / selectAll / searchWorkspace /
//                   noWorkspaceMatch / removeTag / status* / time*
//   table           col* / empty / loading
//   pagination      total / pageSize / prevPage / nextPage
//   selection+batch selectPageAll / batch* / markDone(Count) / reopen(Count) /
//                   undo
//   row actions     open / rename / fork / export / moreActions
export default {
  title: 'Session Management',
  subtitle: 'Manage all sessions. Mark the finished ones as done. Filter by last updated to clean up old sessions in bulk.',
  // Back button on the subtitle row (returns to the chat view underneath).
  back: 'Back',

  // Filter bar
  filterWorkspace: 'Workspace',
  filterStatus: 'Status',
  filterTime: 'Updated',
  allWorkspaces: 'All workspaces',
  selectAll: 'Select all',
  // Workspace multi-select: the menu's search row, its no-match hint, and
  // the trigger tags' remove button.
  searchWorkspace: 'Search workspaces',
  noWorkspaceMatch: 'No matching workspaces',
  removeTag: 'Remove {name}',
  statusAll: 'All statuses',
  statusOpen: 'Open',
  statusDone: 'Done',
  // Updated-time presets (last updated more than N days ago).
  timeAll: 'Any time',
  timeDaysAgo: '{n} days ago',
  // Query-form actions (the filter bar applies drafts only on these).
  query: 'Query',
  reset: 'Reset',

  // Table
  colStatus: 'Status',
  colTitle: 'Title',
  colWorkspace: 'Workspace',
  colPrompt: 'Last prompt',
  colUpdated: 'Updated',
  colCompleted: 'Completed',
  colActions: 'Actions',
  empty: 'No sessions match the current filters',
  loading: 'Loading…',

  // Pagination
  total: '{n} total',
  pageSize: '{n} / page',
  prevPage: 'Previous page',
  nextPage: 'Next page',

  // Selection + batch (P3): header checkbox, batch bar, toasts
  selectPageAll: 'Select all on this page',
  batchSelected: '{n} selected',
  // Select-all-matching (Gmail-style link/state in the batch bar).
  selectAllMatching: 'Select all {total} matching sessions',
  materializingAll: 'Selecting…',
  allMatchingSelected: 'All {n} selected',
  clearSelection: 'Clear selection',
  markDone: 'Mark as done',
  reopen: 'Mark as open',
  markDoneCount: 'Mark as done ({n})',
  reopenCount: 'Mark as open ({n})',
  // Batch toasts — counts are wired in; phrasing avoids plural rules.
  batchDoneToast: '{n} marked as done',
  batchReopenedToast: '{n} moved back to open',
  batchFailedSuffix: ', {n} failed',
  batchDoneFailedNotice: 'Could not mark {n} as done',
  batchReopenFailedNotice: 'Could not move {n} back to open',
  undo: 'Undo',

  // Row actions + context menu (P3)
  open: 'Open session',
  rename: 'Rename…',
  fork: 'Fork',
  export: 'Export',
  moreActions: 'More actions',
} as const;
