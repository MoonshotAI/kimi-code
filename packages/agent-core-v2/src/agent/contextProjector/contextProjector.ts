import { createDecorator } from "#/_base/di";
import type { Message } from '#/app/llmProtocol';

import type { ContextMessage } from '#/agent/contextMemory';

export interface IAgentContextProjectorService {
  readonly _serviceBrand: undefined;

  project(messages: readonly ContextMessage[]): readonly Message[];
}

export const IAgentContextProjectorService = createDecorator<IAgentContextProjectorService>(
  'agentContextProjectorService',
);
