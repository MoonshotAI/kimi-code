/**
 * Top-level timeline items of an AgentTranscript.
 *
 * `items: TranscriptItem[]` is the single ordered timeline. Turns are the
 * pagination unit; markers and taskrefs are attached to the "segment" that
 * follows the preceding turn (or the head segment before the first turn), so
 * every page is a contiguous, self-consistent slice.
 */

import type { MarkerId, TaskId, TaskRefId } from './ids';
import type { TranscriptTurn } from './turn';

/**
 * Marker keys are namespaced strings. Well-known keys are listed in
 * `KNOWN_MARKERS` for renderer dispatch documentation; `custom:<ns>` leaves
 * the door open ("content open") without widening the item union.
 */
export type MarkerKey = string;

export const KNOWN_MARKERS = [
  'compaction',
  'undo',
  'clear',
  'goal',
  'plan.enter',
  'plan.exit',
  'plan.revision',
  'swarm.enter',
  'swarm.exit',
  'skill',
  'cron.fired',
  'notice',
  'hook',
] as const;

/**
 * A structural timeline annotation that does not belong to any step:
 * compaction/undo/clear ribbons, goal updates (also mirrored into
 * `meta.goal`), plan/swarm mode transitions, skill activations, cron firing,
 * hook results, and step-less notices (`marker: 'notice'` with a notice
 * payload).
 */
export interface TranscriptMarker {
  readonly kind: 'marker';
  readonly markerId: MarkerId;
  readonly marker: MarkerKey;
  /** Open content; interpreted by markerRenderers. */
  readonly payload?: unknown;
  readonly at?: string;
}

/**
 * An inline reference to an execution entity in `tasks`. The entity itself is
 * global (never paginated) — this placeholder keeps its position in the
 * reading flow. Foreground→background (`!shell` detach) is just the task's
 * `detached` flag flipping; the ref does not change.
 */
export interface TranscriptTaskRef {
  readonly kind: 'taskref';
  readonly refId: TaskRefId;
  readonly taskId: TaskId;
  readonly at?: string;
}

export type TranscriptItem = TranscriptTurn | TranscriptMarker | TranscriptTaskRef;

export function itemId(item: TranscriptItem): string {
  switch (item.kind) {
    case 'turn':
      return item.turnId;
    case 'marker':
      return item.markerId;
    case 'taskref':
      return item.refId;
  }
}
