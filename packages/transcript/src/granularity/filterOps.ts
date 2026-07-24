/**
 * Pure op-stream clipping for a given grade.
 *
 * `append` is the only grade-gated *kind*: it flows at 'delta' only. All
 * other ops are state-style, so dropping them for lower grades cannot strand
 * the client — the producer re-emits whole-state upserts at flush points, and
 * a client that upgrades gets a full reset snapshot.
 *
 * Content-bearing ops gated below 'block':
 *  - step.upsert / frame.upsert (step & frame detail)
 * Everything else (turn headers, markers, taskrefs, tasks, interactions,
 * prompts, meta, removals, resets) flows at 'turn' and up. `off` admits
 * nothing.
 */

import type { TranscriptGrade } from './grade';
import { GRADE_RANK } from './grade';
import type { AgentTranscriptSnapshot, TranscriptOperation } from '../ops/operation';

export function filterOpsForGrade(
  grade: TranscriptGrade,
  ops: readonly TranscriptOperation[],
): TranscriptOperation[] {
  const rank = GRADE_RANK[grade];
  if (rank === 0) return [];
  return ops.filter((op) => admits(grade, op));
}

function admits(grade: TranscriptGrade, op: TranscriptOperation): boolean {
  switch (op.op) {
    case 'append':
      return GRADE_RANK[grade] >= GRADE_RANK.delta;
    case 'step.upsert':
    case 'frame.upsert':
      return GRADE_RANK[grade] >= GRADE_RANK.block;
    default:
      return true;
  }
}

/**
 * Whether an op batch consists solely of `append` chunks — such batches are
 * safe to mark volatile on the WS channel (droppable on backpressure: the client
 * will hit an offset gap or a later flush and resynchronize).
 */
export function isAppendOnly(ops: readonly TranscriptOperation[]): boolean {
  return ops.length > 0 && ops.every((op) => op.op === 'append');
}

/**
 * Redact a reset snapshot to what the grade admits — the reset counterpart of
 * `filterOpsForGrade` (live ops are filtered per grade; the reset must not
 * leak the detail a lower grade never sees). Below 'block' the step/frame
 * detail is stripped, leaving turn headers, standalone items, tasks,
 * interactions and meta (exactly what 'turn' admits); 'block' and 'delta'
 * carry the full snapshot, and 'off' never reaches here (no reset is sent).
 */
export function redactSnapshotForGrade(
  grade: TranscriptGrade,
  snapshot: AgentTranscriptSnapshot,
): AgentTranscriptSnapshot {
  if (GRADE_RANK[grade] >= GRADE_RANK.block) return snapshot;
  return {
    ...snapshot,
    items: snapshot.items.map((item) => (item.kind === 'turn' ? { ...item, steps: [] } : item)),
  };
}
