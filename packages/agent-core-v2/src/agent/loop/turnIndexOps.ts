/**
 * `loop` domain (L4) — wire Model (`TurnIndexModel`) indexing user-turn
 * boundaries and compaction points by journal position.
 *
 * Declares the rewind coordinate system for `IAgentRewindService`: the journal
 * line index of every user-driven `turn.prompt` record (`turnStarts`) and of
 * the most recent `context.apply_compaction` record (`lastCompactionIndex`,
 * `-1` when none). "User-driven" reuses the single classification
 * implementation (`compactionUserMessageDisposition`) — applied here, on the
 * authoritative submission record, rather than by scanning history messages —
 * so cron/goal/hook-initiated turns never become undo anchors. Both fields are
 * derived through cross-model reducers fed with `OpApplyContext.recordIndex`,
 * so the index requires no scanning at rewind time — and because the model is
 * `rewindable`, a `log.cut` rebuild re-derives it from exactly the surviving
 * records, keeping successive rewinds consistent. Consumed by the Agent-scope
 * `rewindService`; not a user-facing surface.
 */

import { compactionUserMessageDisposition } from '#/agent/contextMemory/compactionHandoff';
import { defineModel } from '#/wire/model';

export interface TurnIndexState {
  readonly turnStarts: readonly number[];
  readonly lastCompactionIndex: number;
}

export const TurnIndexModel = defineModel<TurnIndexState>(
  'turnIndex',
  () => ({ turnStarts: [], lastCompactionIndex: -1 }),
  {
    rewindable: true,
    reducers: {
      'turn.prompt': (state, payload, ctx) =>
        ctx?.recordIndex === undefined ||
        compactionUserMessageDisposition(payload.origin) !== 'keep'
          ? state
          : { ...state, turnStarts: [...state.turnStarts, ctx.recordIndex] },
      'context.apply_compaction': (state, _payload, ctx) =>
        ctx?.recordIndex === undefined ? state : { ...state, lastCompactionIndex: ctx.recordIndex },
    },
  },
);
