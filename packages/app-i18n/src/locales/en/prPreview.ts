// PR preview (desktop-only, dev builds): the strings of PrPreviewIndicator.vue.
// The web app never renders that component; keeping the keys in the shared
// locales matches the terminal.* precedent (docs/native-todos.md).
export default {
  /** Sidebar pill (idle) and dialog title. */
  title: 'PR Preview',
  intro: 'Build a pull request of this repo in an isolated worktree and load its UI into this window. The first build can take a few minutes.',
  prLabel: 'PR number',
  prPlaceholder: 'e.g. 123',
  invalidPr: 'Enter a valid PR number',
  start: 'Start preview',
  cleanup: 'Clean up preview cache',
  cleanupConfirm: 'Delete all cached PR previews except the one currently being previewed? They will be rebuilt on demand next time.',
  cleanupDone: 'Removed {count} cached preview(s)',
  fetching: 'Fetching PR #{pr}…',
  installing: 'Installing dependencies…',
  building: 'Building renderer…',
  activeText: 'Previewing PR #{pr}',
  stop: 'Exit preview',
  rebuild: 'Fetch & rebuild',
  errorTitle: 'Preview failed',
  retry: 'Retry',
  /** Stage names for the failure/hang lines (errorStage). */
  stageFetch: 'fetch the PR code',
  stageInstall: 'install dependencies',
  stageBuild: 'build the renderer',
  stageFailed: 'Failed to {stage}',
  stageHung: 'Building the preview hung while trying to {stage} (no output for 5 minutes, killed — check the network/proxy)',
} as const;
