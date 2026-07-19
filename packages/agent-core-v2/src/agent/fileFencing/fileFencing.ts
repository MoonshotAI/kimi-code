/**
 * `fileFencing` domain (L4) — `IAgentFileFencingService` contract.
 *
 * The Agent-scope tool-hook participant that gates `Write`/`Edit` calls on
 * the `sessionFileLedger` optimistic-concurrency verdict and re-baselines
 * the ledger after successful `Read`/`Write`/`Edit` executions. The service
 * exists for its constructor side effects (it registers by name on the
 * `toolExecutor` hook slots); nothing calls its methods. Bound at Agent
 * scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentFileFencingService {
  readonly _serviceBrand: undefined;
}

export const IAgentFileFencingService: ServiceIdentifier<IAgentFileFencingService> =
  createDecorator<IAgentFileFencingService>('agentFileFencingService');
