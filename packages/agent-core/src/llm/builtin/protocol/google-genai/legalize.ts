import type { ModelLegality } from '#/llm/protocol/rules/model';

export const googleGenAIModelLegality: ModelLegality = {
  sampling: ['temperature', 'topP', 'topK', 'stop', 'seed', 'presencePenalty', 'frequencyPenalty'],
};
