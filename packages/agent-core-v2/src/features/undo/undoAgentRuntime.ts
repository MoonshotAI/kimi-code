import type { IDisposable } from '#/_base/di/lifecycle';
import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
} from '#/agent/runtime/agentRuntime';

import { UndoDomain } from './internal/undoDomain';

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
  private readonly domain: UndoDomain;

  constructor(context: AgentRuntimeContext<null>) {
    this.domain = new UndoDomain(context);
  }

  availability(): UndoAvailability {
    return this.domain.availability();
  }

  undo(count: number): Promise<UndoResult> {
    return this.domain.undo(count);
  }

  registerUndoParticipant(participant: AgentConversationUndoParticipant): IDisposable {
    return this.domain.registerParticipant(participant);
  }
}

export const AgentUndo = defineAgentRuntimeContract<UndoRuntime>('undo');

export const undoAgentRuntimeProvider = defineAgentRuntimeProvider<null, UndoRuntime>(AgentUndo, {
  id: 'undo',
  createApi: (context) => new AgentUndoRuntime(context),
});
