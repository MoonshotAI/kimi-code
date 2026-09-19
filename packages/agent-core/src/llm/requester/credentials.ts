import type { LlmModel } from '#/llm/model';

import {
  mergeRequestHeaders,
  type LlmCredential,
} from './requester';

export function applyCredential(
  model: LlmModel,
  credential: LlmCredential | undefined,
): LlmModel {
  if (credential === undefined) {
    return model;
  }
  return {
    ...model,
    apiKey: credential.apiKey ?? model.apiKey,
    defaultHeaders: mergeRequestHeaders(model.defaultHeaders, credential.headers),
  };
}
