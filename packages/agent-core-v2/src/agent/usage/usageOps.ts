/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';
import { type TokenUsage } from '#/kosong/contract/usage';

export type UsageRecordScope = 'session' | 'turn';

export interface UsageModelState {
  readonly byModel: Record<string, TokenUsage>;
}

const usageRecordSchema = z.object({
  agentId: z.string(),
  model: z.string(),
  usage: z.custom<TokenUsage>(),
  usageScope: z.custom<UsageRecordScope>().optional(),
});

export class UsageRecord extends AgentEvent2<z.infer<typeof usageRecordSchema>> {
  static override readonly type = 'usage.record';
  static override readonly durable = true;
  static override readonly schema = usageRecordSchema;
}
export interface UsageRecord {
  readonly agentId: string;
  readonly model: string;
  readonly usage: TokenUsage;
  readonly usageScope?: UsageRecordScope;
}

export function copyUsage(usage: TokenUsage): TokenUsage {
  return { ...usage };
}
