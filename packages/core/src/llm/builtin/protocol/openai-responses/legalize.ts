/**
 * OpenAI Responses legality rules: the supported sampling parameters.
 */
import type { ModelLegality } from '#/llm/protocol/rules/model';

export const openAIResponsesModelLegality: ModelLegality = {
  sampling: ['temperature', 'topP'],
};
