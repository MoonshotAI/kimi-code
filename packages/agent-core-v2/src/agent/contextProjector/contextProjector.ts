import { createDecorator } from "#/_base/di/instantiation";
import type { Message } from '#/app/llmProtocol/message';

import type { ContextMessage } from '#/agent/contextMemory/types';

export interface IAgentContextProjectorService {
  readonly _serviceBrand: undefined;

  project(messages: readonly ContextMessage[]): readonly Message[];
  projectStrict(messages: readonly ContextMessage[]): readonly Message[];
  projectMediaDegraded(messages: readonly ContextMessage[]): readonly Message[];
  projectMediaStripped(messages: readonly ContextMessage[]): readonly Message[];
}

export const IAgentContextProjectorService = createDecorator<IAgentContextProjectorService>(
  'agentContextProjectorService',
);
