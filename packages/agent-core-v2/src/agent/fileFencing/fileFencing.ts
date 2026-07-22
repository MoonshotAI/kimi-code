/**
 * `fileFencing` domain (L4) — Agent-local read-before-write protection.
 *
 * Defines the Agent-scoped hook participant that owns the file revisions
 * observed by one Agent, gates `Write`/`Edit` calls on those baselines, and
 * refreshes them after successful `Read`/`Write`/`Edit` executions. The
 * service exists for its constructor side effects; nothing calls its methods.
 * Bound at Agent scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentFileFencingService {
  readonly _serviceBrand: undefined;
}

export const IAgentFileFencingService: ServiceIdentifier<IAgentFileFencingService> =
  createDecorator<IAgentFileFencingService>('agentFileFencingService');
