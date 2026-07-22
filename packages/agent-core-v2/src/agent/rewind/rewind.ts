/**
 * `rewind` domain (L6) — Agent-scoped conversation undo contract.
 *
 * Defines the availability and execution surface shared by every undo entry
 * point. Bound at Agent scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface RewindAvailability {
  readonly maxTurns: number;
  readonly stoppedAtCompaction: boolean;
}

export interface IAgentRewindService {
  readonly _serviceBrand: undefined;

  availability(): RewindAvailability;
  rewind(turns: number): Promise<number>;
}

export const IAgentRewindService: ServiceIdentifier<IAgentRewindService> =
  createDecorator<IAgentRewindService>('agentRewindService');
