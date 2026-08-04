/**
 * `sessionTitle` domain (L6) — `IAgentTitlePromptSource` implementation.
 *
 * Reads the first active natural-language prompts from the live `contextMemory`
 * window, merging the `prompt` queue so submissions waiting behind an active
 * turn are visible. The window may be post-compaction — acceptable for title
 * generation: compaction keeps the head user messages, and a title derived
 * from the surviving tail is a fine degradation. Bound at Agent scope.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { promptMetadataTextFromContentParts } from '#/agent/prompt/promptMetadataText';

import { IAgentTitlePromptSource } from './agentTitlePromptSource';

export class AgentTitlePromptSourceService implements IAgentTitlePromptSource {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentPromptService private readonly prompt: IAgentPromptService,
  ) {}

  async firstUserPrompts(limit: number): Promise<readonly string[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) return [];

    const queue = this.prompt.list();
    const result: string[] = [];
    const seenMessageIds = new Set<string>();

    const add = (message: ContextMessage): void => {
      if (result.length >= limit || !isNaturalLanguagePrompt(message)) return;
      if (message.id !== undefined) {
        if (seenMessageIds.has(message.id)) return;
        seenMessageIds.add(message.id);
      }
      const text = promptMetadataTextFromContentParts(message.content);
      if (text !== undefined) result.push(text);
    };

    for (const message of this.context.get()) add(message);
    if (queue.active !== undefined) add(queue.active.message);
    for (const item of queue.pending) add(item.message);
    return result;
  }
}

function isNaturalLanguagePrompt(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  return origin === undefined || origin.kind === 'user';
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentTitlePromptSource,
  AgentTitlePromptSourceService,
  ScopeActivation.OnDemand,
  'sessionTitle',
);
