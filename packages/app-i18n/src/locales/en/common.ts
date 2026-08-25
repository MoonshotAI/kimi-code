export default {
  /** Shared title of the right-side panel — both occupants are previews. */
  preview: 'Preview',
  /** Generic confirm / cancel button labels (used by ConfirmDialog). */
  confirm: 'Confirm',
  cancel: 'Cancel',
  /** Accessible labels for app-ui chrome (close buttons, spinner…). */
  close: 'Close',
  dismiss: 'Dismiss',
  loading: 'Loading',
  copy: 'Copy',
  /** Error boundary fallback (components/ErrorBoundary.vue). */
  errorBoundaryTitle: 'Something went wrong',
  errorBoundaryRetry: 'Try again',
  /** defineAsyncComponent errorComponent (e.g. the design-system overlay). */
  asyncLoadFailed: 'Failed to load. Close this view and try again.',
} as const;
