/**
 * `tooldedup` domain (L4) — per-turn tool-call deduplication.
 *
 * Defines the public contract for tool-call deduplication: the
 * `IToolDedupService` used within a turn to detect repeated calls in the same
 * step and to finalize a call. Turn-scoped — one instance per turn.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IToolDedupService {
  readonly _serviceBrand: undefined;
  checkSameStep(toolCallId: string, args: unknown): boolean;
  finalize(toolCallId: string): void;
}

export const IToolDedupService: ServiceIdentifier<IToolDedupService> =
  createDecorator<IToolDedupService>('toolDedupService');
