// apps/kimi-web/src/lib/snapshotMessages.ts
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

  // The optimistic bubble keeps its client-side id to avoid remounting, while
  // submitPrompt stamps the authoritative v2 user-message id into promptId.
  // Match that identity against the snapshot instead of guessing from content:
  // repeated prompts are distinct messages even when their text/media is equal.
  const snapshotIds = new Set(snapshot.map((m) => m.id));
  const snapshotUserIds = new Set(snapshot.filter((m) => m.role === 'user').map((m) => m.id));

  const older = loaded.filter((message) => {
    const createdAtMs = Date.parse(message.createdAt);
    if (Number.isNaN(createdAtMs) || createdAtMs >= earliestSnapshotMs) return false;
    if (snapshotIds.has(message.id)) return false;
    if (
      message.role === 'user' &&
      message.promptId !== undefined &&
      snapshotUserIds.has(message.promptId)
    ) return false;
    return true;
  });

  return older.length > 0 ? [...older, ...snapshot] : snapshot;
}
