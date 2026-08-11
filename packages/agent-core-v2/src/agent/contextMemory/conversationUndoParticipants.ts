/**
 * `contextMemory` domain — Agent-scoped post-undo reconciliation registry.
 *
 * Hosts state-repair participants for the undo coordinator. Bound at Agent
 * scope.
 */

import { createDecorator } from '#/_base/di/instantiation';
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { BugIndicatingError } from '#/errors';

export interface AgentConversationUndoParticipant {
  readonly id: string;
  reconcileAfterUndo(): Promise<void>;
}

export interface IAgentConversationUndoParticipantRegistry {
  readonly _serviceBrand: undefined;

  register(participant: AgentConversationUndoParticipant): IDisposable;
  list(): readonly AgentConversationUndoParticipant[];
}

export const IAgentConversationUndoParticipantRegistry =
  createDecorator<IAgentConversationUndoParticipantRegistry>(
    'agentConversationUndoParticipantRegistry',
  );

class AgentConversationUndoParticipantRegistry
  extends Service
  implements IAgentConversationUndoParticipantRegistry
{
  declare readonly _serviceBrand: undefined;

  private readonly participants = new Map<string, AgentConversationUndoParticipant>();

  register(participant: AgentConversationUndoParticipant): IDisposable {
    if (this.participants.has(participant.id)) {
      throw new BugIndicatingError(
        `Conversation undo participant "${participant.id}" is already registered`,
      );
    }
    this.participants.set(participant.id, participant);
    return toDisposable(() => {
      if (this.participants.get(participant.id) === participant) {
        this.participants.delete(participant.id);
      }
    });
  }

  list(): readonly AgentConversationUndoParticipant[] {
    return [...this.participants.values()];
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentConversationUndoParticipantRegistry,
  AgentConversationUndoParticipantRegistry,
  ScopeActivation.OnScopeCreated,
  'conversationUndoParticipants',
);
