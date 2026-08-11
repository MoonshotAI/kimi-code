// packages/app-core/src/lib/snapshotMessages.ts
// Merge an authoritative snapshot tail into already-loaded messages.
//
// The session snapshot returns only the most recent bounded page. After a user
// has loaded older pages, replacing the whole message array with that tail would
// drop the older prefix they already fetched and reset scrollback. Preserve any
// loaded messages older than the snapshot window; the snapshot is authoritative
// for its own window and replaces anything inside it.
import type { AppMessage } from '../api/types';

export function mergeSnapshotMessages(
  loaded: AppMessage[],
  snapshot: AppMessage[],
): AppMessage[] {
  if (snapshot.length === 0) return snapshot;
  if (loaded.length === 0) return snapshot;

  const earliestSnapshotMs = Date.parse(snapshot[0]!.createdAt);
  if (Number.isNaN(earliestSnapshotMs)) return snapshot;

  // The optimistic bubble keeps its client-side id to avoid remounting. Match
  // its separately stored daemon ids against the snapshot instead of guessing
  // from content: repeated prompts are distinct even when text/media is equal.
  const snapshotIds = new Set(snapshot.map((m) => m.id));
  const snapshotPromptIds = new Set(
    snapshot.flatMap((m) => m.role === 'user' && m.promptId !== undefined ? [m.promptId] : []),
  );

  const older = loaded.filter((message) => {
    const createdAtMs = Date.parse(message.createdAt);
    if (Number.isNaN(createdAtMs) || createdAtMs >= earliestSnapshotMs) return false;
    if (snapshotIds.has(message.id)) return false;
    if (
      message.role === 'user' &&
      ((message.userMessageId !== undefined && snapshotIds.has(message.userMessageId)) ||
        (message.promptId !== undefined && snapshotPromptIds.has(message.promptId)))
    ) return false;
    return true;
  });

  return older.length > 0 ? [...older, ...snapshot] : snapshot;
}
