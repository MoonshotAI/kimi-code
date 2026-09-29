import {
  createToken,
  lineage,
  useExpose,
  useFire,
  useNode,
  type RuntimeEvent,
} from '#/kernel/index';
import {
  TelemetryRef,
  useTelemetryEvents,
  type TelemetryEventDefinition,
} from '#/builtin/telemetry/index';
import { useAgent, useAgentStore, useSession } from '#/feature/contribution-hooks';
import { createFeature } from '#/feature/feature';
import { isValidUndoCount } from '#/stores/session';

import {
  computeUndoAvailability,
  planUndoCut,
  undoBusyCompactionError,
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

export const UndoRef = createToken<UndoFace>('undo');

const undoTelemetryEvents = [
  { name: 'conversation_undo', properties: ['count'] },
] as const satisfies readonly TelemetryEventDefinition[];

export const undo = createFeature<UndoEvent>('undo', {
  agent() {
    const node = useNode();
    const agent = useAgent();
    const session = useSession();
    const store = useAgentStore();
    const fire = useFire();
    useTelemetryEvents(undoTelemetryEvents);
    const track = (properties: { count: number }): void => {
      const providers = node.providerRef(TelemetryRef).value;
      for (const unit of lineage(node)) {
        const entry = providers.findLast((candidate) => candidate.node === unit);
        if (entry !== undefined) {
          entry.value.track('conversation_undo', properties);
          return;
        }
      }
    };
    const availability = (): UndoAvailability => computeUndoAvailability(store.getState().history);
    const idle = (): boolean => {
      const snapshot = agent.snapshot.value;
      return (
        snapshot !== undefined && snapshot.matches('idle') && snapshot.context.queue.length === 0
      );
    };
    useExpose(UndoRef, {
      availability,
      undo: async (turns) => {
        if (!isValidUndoCount(turns)) throw undoInvalidCountError();
        if (agent.snapshot.value?.context.paused === true) throw undoBusyCompactionError();
        if (!idle()) throw undoBusyTurnError();
        agent.pause();
        try {
          if (!idle()) throw undoBusyTurnError();
          const check = availability();
          if (turns > check.maxTurns) {
            if (check.stoppedAtCompaction) throw undoCompactionBoundaryError();
            if (check.maxTurns === 0) throw undoEmptyError();
            throw undoInsufficientError(turns, check.maxTurns);
          }
          await session.stores.flush();
          const branch = session.stores.branch(agent.agentId);
          const plan =
            branch === undefined
              ? { ok: false as const }
              : planUndoCut(session.stores.tree, branch, turns);
          if (!plan.ok) throw undoCompactionBoundaryError();
          await session.stores.undo(agent.agentId, plan.machineTurns);
          fire({
            type: 'context.undone',
            agentId: agent.agentId,
            turns,
            fromTurnId: plan.fromTurnId,
          });
          track({ count: turns });
        } catch (error) {
          agent.continue();
          throw error;
        }
        await session.close(agent.agentId);
        await session.create({ agentId: agent.agentId });
        return turns;
      },
    });
  },
});
