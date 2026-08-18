/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { Event2 } from '#/app/event/event2';
import { addUsage, type TokenUsage } from '#/kosong/contract/usage';
import { defineState } from '#/state/state';

import type { UsageStatus } from './usage';

export type UsageRecordScope = 'session' | 'turn';

export interface UsageModelState {
  readonly byModel: Record<string, TokenUsage>;
}

const usageRecordSchema = z.object({
  model: z.string(),
  usage: z.custom<TokenUsage>(),
  usageScope: z.custom<UsageRecordScope>().optional(),
});

export class UsageRecord extends Event2<z.infer<typeof usageRecordSchema>> {
  static override readonly type = 'usage.record';
  static override readonly durable = true;
  static override readonly schema = usageRecordSchema;
}
export interface UsageRecord extends z.infer<typeof usageRecordSchema> {}

export const usageKey = defineState('usage', (): UsageModelState => ({ byModel: {} }))
  .replayable({ schema: z.custom<UsageModelState>() })
  .on(UsageRecord, (s, e) => {
  const current = s.byModel[e.model];
  s.byModel[e.model] = current === undefined ? copyUsage(e.usage) : addUsage(current, e.usage);
});

export function copyUsage(usage: TokenUsage): TokenUsage {
  return { ...usage };
}

export function usageStatusFromState(
  model: UsageModelState,
  currentTurn?: TokenUsage,
): UsageStatus {
  const byModel = byModelSnapshot(model.byModel);
  const hasByModel = Object.keys(byModel).length > 0;
  return {
    byModel: hasByModel ? byModel : undefined,
    total: hasByModel ? totalUsage(byModel) : undefined,
    currentTurn: currentTurn === undefined ? undefined : copyUsage(currentTurn),
  };
}

function byModelSnapshot(byModel: Record<string, TokenUsage>): Record<string, TokenUsage> {
  return Object.fromEntries(
    Object.entries(byModel).map(([model, usage]) => [model, copyUsage(usage)]),
  );
}

function totalUsage(byModel: Record<string, TokenUsage>): TokenUsage | undefined {
  let total: TokenUsage | undefined;
  for (const usage of Object.values(byModel)) {
    total = total === undefined ? copyUsage(usage) : addUsage(total, usage);
  }
  return total;
}
