
import type { SessionCreatedSource } from '../../shared/track-events';

let pendingSource: SessionCreatedSource | undefined;

export function setSessionIntent(source: SessionCreatedSource): void {
  pendingSource = source;
}

export function consumeSessionIntent(fallback: SessionCreatedSource): SessionCreatedSource {
  const source = pendingSource ?? fallback;
  pendingSource = undefined;
  return source;
}
