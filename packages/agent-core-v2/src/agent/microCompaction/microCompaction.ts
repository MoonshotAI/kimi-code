/**
 * `microCompaction` domain (L4) - micro-compaction service contract.
 *
 * Defines the truncation tuning model and the Agent-scoped
 * `IAgentMicroCompactionService` used by context projection. Bound at Agent scope.
 */

import { createDecorator } from "#/_base/di";
import type { ContextMessage } from '#/agent/contextMemory';

export interface MicroCompactionConfig {
  keepRecentMessages: number;
  minContentTokens: number;
  cacheMissedThresholdMs: number;
  truncatedMarker: string;
  minContextUsageRatio: number;
}

export interface MicroCompactionEffect {
  readonly truncatedToolResultCount: number;
  readonly truncatedToolResultTokensBefore: number;
  readonly truncatedToolResultTokensAfter: number;
}

export interface IAgentMicroCompactionService {
  readonly _serviceBrand: undefined;

  compact(messages: readonly ContextMessage[]): readonly ContextMessage[];
}

export const IAgentMicroCompactionService =
  createDecorator<IAgentMicroCompactionService>('agentMicroCompactionService');
