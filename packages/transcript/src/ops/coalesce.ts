import type { AppendOp, AppendTarget, TranscriptOperation } from './operation';

export function coalesceAppendOps(ops: readonly TranscriptOperation[]): TranscriptOperation[] {
  const out: TranscriptOperation[] = [];
  for (const op of ops) {
    const prev = out.at(-1);
    if (op.op === 'append' && prev?.op === 'append' && continuesAppend(prev, op)) {
      out[out.length - 1] = { ...prev, text: prev.text + op.text };
      continue;
    }
    out.push(op);
  }
  return out;
}

function continuesAppend(prev: AppendOp, next: AppendOp): boolean {
  return prev.offset + prev.text.length === next.offset && sameTarget(prev.target, next.target);
}

function sameTarget(a: AppendTarget, b: AppendTarget): boolean {
  if (a.type === 'frame') {
    return (
      b.type === 'frame' && a.turnId === b.turnId && a.stepId === b.stepId && a.frameId === b.frameId
    );
  }
  return b.type === 'task' && a.taskId === b.taskId;
}
