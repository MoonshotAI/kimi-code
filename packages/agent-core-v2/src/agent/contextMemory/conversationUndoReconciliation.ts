/**
 * `contextMemory` domain (L4) — Agent-scoped post-undo reconciliation registry.
 *
 * Hosts state-repair participants for the undo coordinator. Bound at Agent
 * scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { createDecorator } from '#/_base/di/instantiation';
import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

export interface AgentConversationUndoReconciliationParticipant {
  readonly id: string;
  reconcileAfterUndo(): Promise<void>;
}

export interface IAgentConversationUndoReconciliationRegistry {
  readonly _serviceBrand: undefined;

  register(participant: AgentConversationUndoReconciliationParticipant): IDisposable;
  list(): readonly AgentConversationUndoReconciliationParticipant[];
}

export const IAgentConversationUndoReconciliationRegistry =
  createDecorator<IAgentConversationUndoReconciliationRegistry>(
    'agentConversationUndoReconciliationRegistry',
  );

class AgentConversationUndoReconciliationRegistry
  extends Disposable
  implements IAgentConversationUndoReconciliationRegistry
{
  declare readonly _serviceBrand: undefined;

  private readonly participants = new Map<string, AgentConversationUndoReconciliationParticipant>();

  register(participant: AgentConversationUndoReconciliationParticipant): IDisposable {
    if (this.participants.has(participant.id)) {
      throw new Error(
        `Conversation undo reconciliation participant "${participant.id}" is already registered`,
      );
    }
    this.participants.set(participant.id, participant);
    return toDisposable(() => {
      if (this.participants.get(participant.id) === participant) {
        this.participants.delete(participant.id);
      }
    });
  }

  list(): readonly AgentConversationUndoReconciliationParticipant[] {
    return [...this.participants.values()];
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentConversationUndoReconciliationRegistry,
  AgentConversationUndoReconciliationRegistry,
  InstantiationType.Eager,
  'conversationUndoReconciliation',
);
