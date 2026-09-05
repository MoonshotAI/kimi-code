import type { MarkerId, TaskId, TaskRefId } from './ids';
import type { TranscriptTurn } from './turn';

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

export interface TranscriptMarker {
  readonly kind: 'marker';
  readonly markerId: MarkerId;
  readonly marker: MarkerKey;
  readonly payload?: unknown;
  readonly at?: string;
}

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
