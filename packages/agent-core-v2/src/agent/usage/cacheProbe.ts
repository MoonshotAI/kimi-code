import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { PromptCacheProbeEvent } from '#/app/telemetry/events';
import { inputTotal, type TokenUsage } from '#human/llm-requester/usage';

export interface IAgentCacheProbeService {
  readonly _serviceBrand: undefined;
}

export const IAgentCacheProbeService: ServiceIdentifier<IAgentCacheProbeService> =
  createDecorator<IAgentCacheProbeService>('agentCacheProbeService');

type PromptCacheUsage = Pick<
  PromptCacheProbeEvent,
  'input_tokens' | 'input_cache_read' | 'input_cache_creation' | 'output_tokens' | 'cache_hit_rate'
>;

export function cacheProbeUsage(usage: TokenUsage | undefined): PromptCacheUsage {
  const inputTokens = usage === undefined ? undefined : inputTotal(usage);
  return {
    input_tokens: inputTokens,
    input_cache_read: usage?.inputCacheRead,
    input_cache_creation: usage?.inputCacheCreation,
    output_tokens: usage?.output,
    cache_hit_rate:
      usage === undefined || inputTokens === undefined || inputTokens === 0
        ? undefined
        : usage.inputCacheRead / inputTokens,
  };
}
