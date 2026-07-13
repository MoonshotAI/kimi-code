// apps/kimi-web/src/lib/snapshotMessages.ts
// Merge an authoritative snapshot tail into already-loaded messages.
//
// The session snapshot returns only the most recent bounded page. After a user
// has loaded older pages, replacing the whole message array with that tail would
// drop the older prefix they already fetched and reset scrollback. Preserve any
// loaded messages older than the snapshot window; the snapshot is authoritative
// for its own window and replaces anything inside it.
import { isOptimisticUserMessage, sameUserMessageLoosely } from '../api/daemon/eventReducer';
import type { AppMessage } from '../api/types';

export function mergeSnapshotMessages(
  loaded: AppMessage[],
  snapshot: AppMessage[],
): AppMessage[] {
  if (snapshot.length === 0) return snapshot;
  if (loaded.length === 0) return snapshot;

  const earliestSnapshotMs = Date.parse(snapshot[0]!.createdAt);
  if (Number.isNaN(earliestSnapshotMs)) return snapshot;

  // A snapshot can land before the WS echo merges the optimistic user message:
  // the optimistic copy's client-side createdAt falls just before the window and
  // would be kept as an "older" message next to the snapshot's authoritative one,
  // rendering a duplicate bubble the late echo can never clean up. The snapshot
  // is authoritative, so drop any optimistic copy it already covers.
  const snapshotIds = new Set(snapshot.map((m) => m.id));
  const snapshotUserPromptIds = new Set(
    snapshot.filter((m) => m.role === 'user' && m.promptId !== undefined).map((m) => m.promptId),
  );
  const snapshotUserMessages = snapshot.filter((m) => m.role === 'user');

  const older = loaded.filter((message) => {
    const createdAtMs = Date.parse(message.createdAt);
    if (Number.isNaN(createdAtMs) || createdAtMs >= earliestSnapshotMs) return false;
    if (snapshotIds.has(message.id)) return false;
    if (isOptimisticUserMessage(message)) {
      // promptId is stamped only after submitPrompt resolves; before that, fall
      // back to the (text, media-count) shape the echo reducer also uses.
      if (message.promptId !== undefined && snapshotUserPromptIds.has(message.promptId)) return false;
      if (snapshotUserMessages.some((m) => sameUserMessageLoosely(m, message))) return false;
    }
    return true;
  });

  return older.length > 0 ? [...older, ...snapshot] : snapshot;
}
