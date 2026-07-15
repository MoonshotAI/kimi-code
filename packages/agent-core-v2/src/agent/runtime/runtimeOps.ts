/**
 * `runtime` domain (L4) — wire Model (`RuntimeModel`) and the `runtime.set_phase`
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

import { z } from 'zod';

import { defineModel } from '#/wire/model';

import type { AgentPhase } from './runtime';

export interface RuntimeModelState {
  readonly phase: AgentPhase;
}

export const RuntimeModel = defineModel<RuntimeModelState>('runtime', () => ({
  phase: { kind: 'idle' },
}));

declare module '#/wire/types' {
  interface TransientOpMap {
    'runtime.set_phase': typeof setRuntimePhase;
    'activity.set_snapshot': typeof setActivitySnapshot;
  }
}

export const setRuntimePhase = RuntimeModel.defineOp('runtime.set_phase', {
  schema: z.object({ phase: z.custom<AgentPhase>() }),
  persist: false,
  apply: (s, p) => (phaseEqual(s.phase, p.phase) ? s : { phase: p.phase }),
  toEvent: (p) => ({ type: 'agent.status.updated' as const, phase: p.phase }),
});

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

import type { AgentActivitySnapshot } from '#/activity/activity';

export const ActivityModel = defineModel<AgentActivitySnapshot>('activity', () => ({
  lane: 'idle',
  background: [],
}));

export const setActivitySnapshot = ActivityModel.defineOp('activity.set_snapshot', {
  schema: z.object({ next: z.custom<AgentActivitySnapshot>() }),
  persist: false,
  apply: (s, p) => (snapshotEqual(s, p.next) ? s : p.next),
  toEvent: (p) => ({ type: 'agent.activity.updated' as const, ...p.next }),
});

export function snapshotEqual(a: AgentActivitySnapshot, b: AgentActivitySnapshot): boolean {
  if (a.lane !== b.lane) return false;
  if (a.background.length !== b.background.length) return false;
  if ((a.turn === undefined) !== (b.turn === undefined)) return false;
  if (a.turn !== undefined && b.turn !== undefined) {
    const ta = a.turn;
    const tb = b.turn;
    if (
      ta.turnId !== tb.turnId ||
      ta.phase !== tb.phase ||
      ta.stream !== tb.stream ||
      ta.step !== tb.step ||
      ta.ending !== tb.ending ||
      ta.endingReason !== tb.endingReason ||
      ta.pendingApprovals.length !== tb.pendingApprovals.length ||
      ta.activeToolCalls.length !== tb.activeToolCalls.length
    ) {
      return false;
    }
    if (ta.retry?.nextAttempt !== tb.retry?.nextAttempt) return false;
  }
  if ((a.lastTurn === undefined) !== (b.lastTurn === undefined)) return false;
  if (a.lastTurn !== undefined && b.lastTurn !== undefined) {
    if (a.lastTurn.turnId !== b.lastTurn.turnId || a.lastTurn.reason !== b.lastTurn.reason) {
      return false;
    }
  }
  return true;
}

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'agent.activity.updated': AgentActivitySnapshot & { readonly type: 'agent.activity.updated' };
  }
}
