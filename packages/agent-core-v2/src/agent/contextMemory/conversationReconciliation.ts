/**
 * `contextMemory` domain (L4) — Agent-scoped post-rewind reconciliation registry.
 *
 * Hosts state-repair and derived-projection participants for the rewind
 * coordinator. Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { createDecorator } from '#/_base/di/instantiation';
import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

export interface AgentConversationReconciliationParticipant {
  readonly id: string;
  readonly phase?: AgentConversationReconciliationPhase;
  reconcileAfterRewind(): Promise<void>;
}

export type AgentConversationReconciliationPhase = 'state' | 'projection';

export interface IAgentConversationReconciliationRegistry {
  readonly _serviceBrand: undefined;

  register(participant: AgentConversationReconciliationParticipant): IDisposable;
  list(): readonly AgentConversationReconciliationParticipant[];
}

export const IAgentConversationReconciliationRegistry =
  createDecorator<IAgentConversationReconciliationRegistry>(
    'agentConversationReconciliationRegistry',
  );

class AgentConversationReconciliationRegistry
  extends Disposable
  implements IAgentConversationReconciliationRegistry
{
  declare readonly _serviceBrand: undefined;

  private readonly participants = new Map<string, AgentConversationReconciliationParticipant>();

  register(participant: AgentConversationReconciliationParticipant): IDisposable {
    if (this.participants.has(participant.id)) {
      throw new Error(
        `Conversation reconciliation participant "${participant.id}" is already registered`,
      );
    }
    this.participants.set(participant.id, participant);
    return toDisposable(() => {
      if (this.participants.get(participant.id) === participant) {
        this.participants.delete(participant.id);
      }
    });
  }

  list(): readonly AgentConversationReconciliationParticipant[] {
    return [...this.participants.values()];
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentConversationReconciliationRegistry,
  AgentConversationReconciliationRegistry,
  InstantiationType.Eager,
  'conversationReconciliation',
);
