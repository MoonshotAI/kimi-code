// A new-session draft can outlive the click that opened it: the session is not
// created until the first prompt is sent. Keep that draft source until the
// creation site can claim it.

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
