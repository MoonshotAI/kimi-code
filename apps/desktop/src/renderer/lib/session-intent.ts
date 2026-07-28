// Pending source for the next session_created event. Entry points (sidebar,
// shortcut, tray, ...) declare why a session is about to be opened; the
// creation/selection site consumes it exactly once so a stale intent never
// leaks into a later, unrelated session switch.

import type { SessionCreatedSource } from '../../shared/track-events';

let pendingSource: SessionCreatedSource | undefined;

export function setSessionIntent(source: SessionCreatedSource): void {
  pendingSource = source;
}

/** Take (and clear) the pending source; `fallback` when none was declared. */
export function consumeSessionIntent(fallback: SessionCreatedSource): SessionCreatedSource {
  const source = pendingSource ?? fallback;
  pendingSource = undefined;
  return source;
}
