// PR preview (desktop dev builds / Kimi Code Canary): the strings of
// PrPreviewIndicator.vue. The web app never renders that component; keeping
// the keys in the shared locales matches the terminal.* precedent
// (docs/native-todos.md).
export default {
  /** Sidebar pill (idle) and dialog title. */
  title: 'PR Preview',
  intro: 'Build a pull request or branch of this repo in an isolated worktree and open its UI in a separate window. The first build can take a few minutes.',
  prLabel: 'Preview target',
  customRefPlaceholder: 'PR number, branch, tag, or commit SHA',
  invalidRef: 'Enter a valid branch name, tag, or commit SHA',
  start: 'Start preview',
  cleanup: 'Clean up preview cache',
  cleanupConfirm: 'Delete all cached previews except the one currently being previewed? They will be rebuilt on demand next time.',
  cleanupDone: 'Removed {count} cached preview(s)',
  fetching: 'Fetching {pr}…',
  installing: 'Installing dependencies…',
  building: 'Building renderer…',
  activeText: 'Previewing {pr}',
  stop: 'Exit preview',
  rebuild: 'Fetch & rebuild',
  errorTitle: 'Preview failed',
  retry: 'Retry',
  /** Stage names for the failure/hang lines (errorStage). */
  stageFetch: 'fetch the code',
  stageInstall: 'install dependencies',
  stageBuild: 'build the renderer',
  stageFailed: 'Failed to {stage}',
  stageHung: 'Building the preview hung while trying to {stage} (no output for 5 minutes, killed — check the network/proxy)',
} as const;
