/**
 * `microCompaction` domain (L4) — wire Model (`MicroCompactionModel`) and the
 * `micro_compaction.apply` (`microCompactionApply`) Op for the cache-miss
 * compaction cutoff over `contextMemory`.
 *
 * Declares the cutoff as `{ cutoff }` (initial `{ cutoff: 0 }`): the message
 * index below which old tool results are truncated. `cutoff` is a non-negative
 * index (0 truncates nothing), so the reset value folds into the same Op as
 * `cutoff: 0` rather than a separate record — keeping the resume-time cutoff
 * reset (previously a `full_compaction.complete` resumer) inside the same
 * replayable stream. `apply` is pure and returns the SAME reference on a no-op
 * so the wire's reference-equality gate stays quiet; it carries no
 * non-determinism, so `wire.dispatch(microCompactionApply(...))` and
 * `wire.replay` produce identical state — replay rebuilds the cutoff, including
 * the explicit `cutoff: 0` resets recorded on the live full-compaction /
 * context-clear paths. Consumed by the Agent-scope `microCompactionService`.
 */

import { defineModel, defineOp } from '#/wire';

export interface MicroCompactionState {
  readonly cutoff: number;
}

export const MicroCompactionModel = defineModel<MicroCompactionState>('microCompaction', () => ({
  cutoff: 0,
}));

export interface MicroCompactionApplyPayload {
  readonly cutoff: number;
}

export const microCompactionApply = defineOp(MicroCompactionModel, 'micro_compaction.apply', {
  apply: (s, p: MicroCompactionApplyPayload): MicroCompactionState => {
    const cutoff = Math.max(0, p.cutoff);
    return s.cutoff === cutoff ? s : { cutoff };
  },
});
