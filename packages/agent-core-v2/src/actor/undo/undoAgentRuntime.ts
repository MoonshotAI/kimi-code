import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { isValidUndoCount } from '#/actor/contextMemory/conversationTime';
import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
} from '#/actor/agentRuntime';
import { BugIndicatingError, ErrorCodes, Error2 } from '#/errors';

import { undoActorLogic, type UndoActorContext } from './internal/undoMachine';
import { undoAvailability } from './internal/undoOperations';

export interface UndoAvailability {
  readonly canUndo: boolean;
}

export interface UndoResult {
  readonly applied: boolean;
}

export interface AgentConversationUndoParticipant {
  readonly id: string;
  reconcileAfterUndo(): Promise<void>;
}

export interface UndoRuntime {
  availability(): UndoAvailability;
  undo(count: number): Promise<UndoResult>;
  registerUndoParticipant(participant: AgentConversationUndoParticipant): IDisposable;
}

export class AgentUndoRuntime implements UndoRuntime {
  constructor(private readonly context: AgentRuntimeContext<null>) {}

  availability(): UndoAvailability {
    return undoAvailability(this.context);
  }

  async undo(count: number): Promise<UndoResult> {
    if (!isValidUndoCount(count)) {
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        'Undo count must be a positive safe integer',
        { details: { field: 'count' } },
      );
    }
    return new Promise<UndoResult>((resolve, reject) => {
      this.context.send({ type: 'undo.requested', request: { count, resolve, reject } });
    });
  }

  registerUndoParticipant(participant: AgentConversationUndoParticipant): IDisposable {
    const participants = this.context.getLogicState<UndoActorContext>().participants;
    if (participants.has(participant.id)) {
      throw new BugIndicatingError(
        `Conversation undo participant "${participant.id}" is already registered`,
      );
    }
    this.context.send({ type: 'undo.participantRegistered', participant });
    return toDisposable(() => {
      try {
        this.context.send({ type: 'undo.participantUnregistered', id: participant.id, participant });
      } catch {}
    });
  }
}

export const AgentUndo = defineAgentRuntimeContract<UndoRuntime>('undo');

export const undoAgentRuntimeProvider = defineAgentRuntimeProvider<null, UndoRuntime>(AgentUndo, {
  id: 'undo',
  logic: undoActorLogic,
  createApi: (context) => new AgentUndoRuntime(context),
});
