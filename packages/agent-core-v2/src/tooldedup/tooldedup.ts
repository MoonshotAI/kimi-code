/**
 * `tooldedup` domain (L4) — per-turn tool-call deduplication.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IToolDedupService {
  readonly _serviceBrand: undefined;
  checkSameStep(toolCallId: string, args: unknown): boolean;
  finalize(toolCallId: string): void;
}

export const IToolDedupService: ServiceIdentifier<IToolDedupService> =
  createDecorator<IToolDedupService>('toolDedupService');
