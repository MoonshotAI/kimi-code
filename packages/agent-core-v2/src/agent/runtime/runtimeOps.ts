/**
 * `runtime` domain (L5) — wire Model (`RuntimeModel`) and the `runtime.set_phase`
 * Op (`setRuntimePhase`) that holds the agent's whole live phase.
 *
 * Declares the phase as a single-field wire Model (`{ phase }`, initial
 * `{ kind: 'idle' }`) plus one Op whose `apply` is a pure, edge-triggered
 * replacement: it returns the SAME reference when the incoming phase is
 * unchanged under `phaseEqual` (which ignores `since` / `at` timestamps), so the
 * wire's reference-equality gate stays quiet and high-frequency deltas do not
 * flood subscribers. The Op is live-only because `runtime.set_phase` is not a
 * v1 record type: nothing is persisted or replayed, and resumed agents start
 * back at `idle`. The `agent.status.updated` `phase` slice is derived from
 * the Op's `toEvent` (published on `dispatch`, never on `replay`). Consumed
 * by the Agent-scope `runtimeService`.
 */

import { defineModel } from '#/wire/model';
import { defineOp } from '#/wire/op';

import type { AgentPhase } from './runtime';

export interface RuntimeModelState {
  readonly phase: AgentPhase;
}

export const RuntimeModel = defineModel<RuntimeModelState>('runtime', () => ({
  phase: { kind: 'idle' },
}));

export const setRuntimePhase = defineOp(RuntimeModel, 'runtime.set_phase', {
  persist: false,
  apply: (s, p: { phase: AgentPhase }): RuntimeModelState =>
    phaseEqual(s.phase, p.phase) ? s : { phase: p.phase },
  toEvent: (p) => ({ type: 'agent.status.updated' as const, phase: p.phase }),
});

/**
 * Structural equality for phase transitions, ignoring the `since` / `at`
 * timestamps so that re-entering the same logical phase (e.g. a burst of
 * same-stream deltas) is treated as a no-op.
 */
export function phaseEqual(a: AgentPhase, b: AgentPhase): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'idle':
      return true;
    case 'running': {
      const c = b as typeof a;
      return a.turnId === c.turnId && a.step === c.step && a.stepId === c.stepId;
    }
    case 'streaming': {
      const c = b as typeof a;
      return (
        a.turnId === c.turnId &&
        a.step === c.step &&
        a.stepId === c.stepId &&
        a.stream === c.stream &&
        a.toolCallId === c.toolCallId
      );
    }
    case 'tool_call': {
      const c = b as typeof a;
      return a.turnId === c.turnId && a.toolCallId === c.toolCallId;
    }
    case 'retrying': {
      const c = b as typeof a;
      return (
        a.turnId === c.turnId &&
        a.step === c.step &&
        a.failedAttempt === c.failedAttempt &&
        a.nextAttempt === c.nextAttempt
      );
    }
    case 'awaiting_approval': {
      const c = b as typeof a;
      return a.turnId === c.turnId;
    }
    case 'interrupted': {
      const c = b as typeof a;
      return a.turnId === c.turnId && a.reason === c.reason;
    }
    case 'ended': {
      const c = b as typeof a;
      return a.turnId === c.turnId && a.reason === c.reason;
    }
  }
}
