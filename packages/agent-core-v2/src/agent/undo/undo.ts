/**
 * `undo` domain (L6) — Agent-scoped conversation undo contract.
 *
 * Defines the availability and idle-only execution surface shared by every
 * undo entry point. Bound at Agent scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface UndoAvailability {
  readonly maxTurns: number;
  readonly stoppedAtCompaction: boolean;
}

export interface IAgentConversationUndoService {
  readonly _serviceBrand: undefined;

  availability(): UndoAvailability;
  undo(turns: number): Promise<number>;
}

export const IAgentConversationUndoService: ServiceIdentifier<IAgentConversationUndoService> =
  createDecorator<IAgentConversationUndoService>('agentConversationUndoService');
