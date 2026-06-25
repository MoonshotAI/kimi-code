import type { TokenUsage } from '@moonshot-ai/kosong';

import { createDecorator } from "#/_base/di";

export type UsageRecordScope = 'session' | 'turn';

export interface UsageStatus {
  readonly byModel?: Record<string, TokenUsage>;
  readonly total?: TokenUsage;
  readonly currentTurn?: TokenUsage;
}

export interface IUsageService {
  beginTurn(): void;
  endTurn(): void;
  record(model: string, usage: TokenUsage, scope?: UsageRecordScope): void;
  data(): UsageStatus;
  status(): UsageStatus | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IUsageService = createDecorator<IUsageService>('usageService.agent');
