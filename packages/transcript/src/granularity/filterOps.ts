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

export function isAppendOnly(ops: readonly TranscriptOperation[]): boolean {
  return ops.length > 0 && ops.every((op) => op.op === 'append');
}

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
