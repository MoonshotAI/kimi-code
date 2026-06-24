/**
 * `context` domain (L4) — per-agent conversation context / memory.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ContextMessage {
  readonly role: string;
  readonly content: unknown;
}

export interface IContextService {
  readonly _serviceBrand: undefined;
  appendMessage(msg: ContextMessage): void;
  appendSystemReminder(text: string): void;
  project(): readonly ContextMessage[];
  applyCompaction(summary: string): void;
  undo(): void;
  tokenUsage(): number;
}

export const IContextService: ServiceIdentifier<IContextService> =
  createDecorator<IContextService>('contextService');
