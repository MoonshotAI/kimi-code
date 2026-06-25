/**
 * `compaction` domain (L4) — context compaction (full + micro).
 *
 * Defines the public contract for compaction: the `ICompactionService` used to
 * trigger context compaction for a reason. Agent-scoped — one instance per agent.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ICompactionService {
  readonly _serviceBrand: undefined;
  compact(reason: string): Promise<void>;
}

export const ICompactionService: ServiceIdentifier<ICompactionService> =
  createDecorator<ICompactionService>('compactionService');
