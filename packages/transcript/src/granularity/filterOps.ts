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
 * Everything else (turn headers, markers, taskrefs, tasks, meta, removals,
 * resets) flows at 'turn' and up. `off` admits nothing.
 */

import type { TranscriptGrade } from './grade';
import { GRADE_RANK } from './grade';
import type { TranscriptOperation } from '../ops/operation';

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
 * safe to mark volatile on the wire (droppable on backpressure: the client
 * will hit an offset gap or a later flush and resynchronize).
 */
export function isAppendOnly(ops: readonly TranscriptOperation[]): boolean {
  return ops.length > 0 && ops.every((op) => op.op === 'append');
}
