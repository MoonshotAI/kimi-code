import type { ModelLegality } from '#/llm/protocol/rules/model';

export const openAIResponsesModelLegality: ModelLegality = {
  sampling: ['temperature', 'topP'],
};
