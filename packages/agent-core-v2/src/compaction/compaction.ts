/**
 * `compaction` domain (L4) — context compaction (full + micro).
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ICompactionService {
  readonly _serviceBrand: undefined;
  compact(reason: string): Promise<void>;
}

export const ICompactionService: ServiceIdentifier<ICompactionService> =
  createDecorator<ICompactionService>('compactionService');
