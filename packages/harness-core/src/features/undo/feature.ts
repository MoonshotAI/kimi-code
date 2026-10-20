import { createFeature, useAgent, useApp, useSession } from '@moonshot-ai/agent-core/app/index';
import {
  createFacadeToken,
  useExpose,
  useFire,
  useInject,
  type RuntimeEvent,
} from '@moonshot-ai/agent-core/kernel/index';
import { SessionError } from '@moonshot-ai/agent-core/session/index';

import {
  TelemetryRef,
  useTelemetryEvents,
  type TelemetryEventDefinition,
} from '#/features/telemetry/index';
import { undoAgentTurns } from '#/runtime/index';

import {
  computeUndoAvailability,
  isValidUndoCount,
  planUndoCut,
  undoBusyTurnError,
  undoCompactionBoundaryError,
  undoEmptyError,
  undoInsufficientError,
  undoInvalidCountError,
  type UndoAvailability,
} from './anchors';

export interface ContextUndoneEvent extends RuntimeEvent {
  readonly type: 'context.undone';
  readonly agentId: string;
  readonly turns: number;
  readonly fromTurnId?: number;
}

export type UndoEvent = ContextUndoneEvent;

export interface UndoFace {
  availability(): UndoAvailability;
  undo(turns: number): Promise<number>;
}

export const UndoRef = createFacadeToken<UndoFace>('undo');

const undoTelemetryEvents = [
  { name: 'conversation_undo', properties: ['count'] },
] as const satisfies readonly TelemetryEventDefinition[];

function translateUndoError(
  error: unknown,
  turns: number,
  availability: () => UndoAvailability,
): unknown {
  if (!(error instanceof SessionError)) return error;
  if (error.reason === 'busy') return undoBusyTurnError();
  if (error.reason === 'invalid-count') return undoInvalidCountError();
  if (error.reason === 'unknown-agent') return undoCompactionBoundaryError();
  if (error.reason === 'insufficient') {
    const check = availability();
    if (check.stoppedAtCompaction) return undoCompactionBoundaryError();
    if (check.maxTurns === 0) return undoEmptyError();
    return undoInsufficientError(turns, check.maxTurns);
  }
  return error;
}

export const undo = createFeature<UndoEvent>('undo', {
  agent() {
    const app = useApp();
    const session = useSession();
    const agent = useAgent();
    const fire = useFire();
    useTelemetryEvents(undoTelemetryEvents);
    const telemetry = useInject(TelemetryRef);
    let queue: Promise<void> = Promise.resolve();
    const idle = (): boolean => {
      const state = agent.loop.state;
      return (
        state.status === 'idle' &&
        state.inbox.normal.length === 0 &&
        state.inbox.notify.length === 0 &&
        state.inbox.remind.length === 0
      );
    };
    const availability = (): UndoAvailability =>
      computeUndoAvailability(agent.view.getState().messages);
    const undoNow = async (turns: number): Promise<number> => {
      if (!idle()) throw undoBusyTurnError();
      await agent.flush();
      const check = availability();
      if (turns > check.maxTurns) {
        if (check.stoppedAtCompaction) throw undoCompactionBoundaryError();
        if (check.maxTurns === 0) throw undoEmptyError();
        throw undoInsufficientError(turns, check.maxTurns);
      }
      const plan = planUndoCut(agent.log.replica.entries(), turns);
      if (!plan.ok) throw undoCompactionBoundaryError();
      try {
        await undoAgentTurns(app, session, agent.id, plan.machineTurns);
      } catch (error) {
        throw translateUndoError(error, turns, availability);
      }
      fire({ type: 'context.undone', agentId: agent.id, turns, fromTurnId: plan.fromTurnId });
      telemetry.value?.track('conversation_undo', { count: turns });
      return turns;
    };
    useExpose(UndoRef, {
      availability,
      undo: (turns) => {
        if (!isValidUndoCount(turns)) return Promise.reject(undoInvalidCountError());
        const run = queue.then(() => undoNow(turns));
        queue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    });
  },
});
