import { MAIN_AGENT_ID } from '#/feature/contribution-hooks';
import type { RecordEvent } from '#/store/journal';
import type { Projection } from '#/store/store';
import type { BranchRef } from '#/store/tree';
import type { AgentStore } from '#/stores/agent';
import type { AgentSnapshot } from './agentUnit';

export type SessionTurnOutcome = 'completed' | 'cancelled' | 'failed';

export type SessionOpenSource = 'startup' | 'resume' | 'fork';

export interface SessionStatus {
  readonly busy: boolean;
  readonly mainTurnActive: boolean;
  readonly source: SessionOpenSource;
  readonly lastTurnReason?: SessionTurnOutcome;
}

type TurnOutcome = 'done' | 'failed' | 'aborted';

export type LastTurn = { readonly turnId: number; readonly outcome: TurnOutcome };

export interface AgentWork {
  readonly turnActive: boolean;
  readonly background: number;
}

const lastTurnOutcomeProjection: Projection<LastTurn | undefined, RecordEvent, BranchRef> = {
  initial: () => undefined,
  reduce: (state, event) => {
    if (event.type !== 'turn.ended') return state;
    return { turnId: event['turnId'] as number, outcome: event['outcome'] as TurnOutcome };
  },
};

function toSessionOutcome(outcome: TurnOutcome): SessionTurnOutcome {
  return outcome === 'done' ? 'completed' : outcome === 'aborted' ? 'cancelled' : 'failed';
}

export function lastTurnOutcomeOf(store: AgentStore): LastTurn | undefined {
  const view = store.attach(lastTurnOutcomeProjection);
  const last = view.getState();
  view.dispose();
  return last;
}

export function agentWorkOf(snapshot: AgentSnapshot | undefined): AgentWork {
  if (snapshot === undefined || snapshot.status !== 'active') {
    return { turnActive: false, background: 0 };
  }
  return {
    turnActive: snapshot.matches('running'),
    background: Object.keys(snapshot.context.background).length,
  };
}

export function lastTurnOfMeta(meta: unknown): LastTurn | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined;
  const lastTurn = (meta as { lastTurn?: unknown }).lastTurn;
  if (typeof lastTurn !== 'object' || lastTurn === null) return undefined;
  const turnId = (lastTurn as { turnId?: unknown }).turnId;
  const outcome = (lastTurn as { outcome?: unknown }).outcome;
  if (typeof turnId !== 'number') return undefined;
  if (outcome !== 'done' && outcome !== 'failed' && outcome !== 'aborted') return undefined;
  return { turnId, outcome };
}

export function sessionStatusOf(
  works: Iterable<readonly [string, AgentWork]>,
  lastTurn: LastTurn | undefined,
  source: SessionOpenSource,
): SessionStatus {
  let busy = false;
  let mainTurnActive = false;
  for (const [agentId, work] of works) {
    if (work.turnActive || work.background > 0) busy = true;
    if (agentId === MAIN_AGENT_ID) mainTurnActive = work.turnActive;
  }
  const lastTurnReason = lastTurn === undefined ? undefined : toSessionOutcome(lastTurn.outcome);
  return {
    busy,
    mainTurnActive,
    source,
    ...(lastTurnReason !== undefined ? { lastTurnReason } : {}),
  };
}
