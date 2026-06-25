/**
 * `usage` domain (L4) — per-agent token and cost accounting.
 *
 * Defines the `UsageTotals` model and the `IUsageService` used to record and
 * read token usage. Agent-scoped — one instance per agent.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface UsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface IUsageService {
  readonly _serviceBrand: undefined;
  readonly totals: UsageTotals;
  record(inputTokens: number, outputTokens: number): void;
}

export const IUsageService: ServiceIdentifier<IUsageService> =
  createDecorator<IUsageService>('usageService');
