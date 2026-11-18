import anthropicTraceId from './anthropic-trace-id';
import openAIQuotaError from './openai-quota-error';
import openAITraceId from './openai-trace-id';
import responsesTraceId from './responses-trace-id';

export const kimiOpenAITransportFixtures = [openAITraceId, openAIQuotaError];
export const kimiResponsesTransportFixtures = [responsesTraceId];
export const kimiAnthropicTransportFixtures = [anthropicTraceId];
