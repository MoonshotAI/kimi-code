import { createDecorator } from '../../../di';

import type { LLMEvent, LLMRequestOverrides } from '../types';

export interface ILLMRequester {
  request(overrides?: LLMRequestOverrides, signal?: AbortSignal): AsyncIterable<LLMEvent>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ILLMRequester = createDecorator<ILLMRequester>('agentLLMRequesterService');
