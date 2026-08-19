import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import {
  promptMetadataTextFromContentParts,
  promptMetadataTextFromText,
} from '#/agent/prompt/promptMetadataText';
import type { ContentPart } from '#/kosong/contract/message';

import {
  IAgentTitlePromptSource,
  type TitleDigestExcerpt,
  type TitleTurnExcerpt,
} from './agentTitlePromptSource';

export class AgentTitlePromptSourceService implements IAgentTitlePromptSource {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentPromptService private readonly prompt: IAgentPromptService,
  ) {}

  async firstUserPrompts(limit: number): Promise<readonly string[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) return [];

    const result: string[] = [];
    const seenMessageIds = new Set<string>();

    const add = (message: ContextMessage): void => {
      if (result.length >= limit || !isNaturalLanguagePrompt(message)) return;
      if (message.id !== undefined) {
        if (seenMessageIds.has(message.id)) return;
        seenMessageIds.add(message.id);
      }
      const text = promptMetadataTextFromUserMessage(message);
      if (text !== undefined) result.push(text);
    };

    for (const message of this.combinedMessages()) add(message);
    return result;
  }

  async firstTurnExcerpt(): Promise<TitleTurnExcerpt> {
    const all = this.combinedMessages();
    const firstUserIndex = all.findIndex(isNaturalLanguagePrompt);
    if (firstUserIndex < 0) return {};
    const user = promptMetadataTextFromUserMessage(all[firstUserIndex]!);
    const span: ContextMessage[] = [];
    for (const message of all.slice(firstUserIndex + 1)) {
      if (isNaturalLanguagePrompt(message)) break;
      span.push(message);
    }
    return { user, assistant: finalAssistantText(span) };
  }

  async digestExcerpt(): Promise<TitleDigestExcerpt> {
    const all = this.combinedMessages();
    const firstUserIndex = all.findIndex(isNaturalLanguagePrompt);
    if (firstUserIndex < 0) return {};
    let lastUserIndex = -1;
    for (let index = all.length - 1; index >= 0; index--) {
      if (isNaturalLanguagePrompt(all[index]!)) {
        lastUserIndex = index;
        break;
      }
    }
    const firstUser = promptMetadataTextFromUserMessage(all[firstUserIndex]!);
    const lastUser =
      lastUserIndex > firstUserIndex
        ? promptMetadataTextFromUserMessage(all[lastUserIndex]!)
        : undefined;
    const assistant =
      finalAssistantText(all.slice(lastUserIndex + 1)) ??
      finalAssistantText(all.slice(firstUserIndex + 1));
    return { firstUser, lastUser, assistant };
  }

  private combinedMessages(): ContextMessage[] {
    const queue = this.prompt.list();
    const all = [...this.context.get()];
    if (queue.active !== undefined) all.push(queue.active.message);
    for (const item of queue.pending) all.push(item.message);
    return all;
  }
}

function isNaturalLanguagePrompt(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  return origin === undefined || origin.kind === 'user';
}

function promptMetadataTextFromUserMessage(message: ContextMessage): string | undefined {
  const bundled = message.origin?.kind === 'user' ? (message.origin.skillActivations?.length ?? 0) : 0;
  return promptMetadataTextFromContentParts(
    bundled === 0 ? message.content : message.content.slice(bundled),
  );
}

function finalAssistantText(messages: readonly ContextMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== 'assistant') continue;
    const text = assistantTextFromContentParts(message.content);
    if (text !== undefined) return text;
  }
  return undefined;
}

function assistantTextFromContentParts(parts: readonly ContentPart[]): string | undefined {
  const texts: string[] = [];
  for (const part of parts) {
    if (part.type === 'text' && part.text.trim().length > 0) texts.push(part.text);
  }
  if (texts.length === 0) return undefined;
  return promptMetadataTextFromText(texts.join('\n'));
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentTitlePromptSource,
  AgentTitlePromptSourceService,
  ScopeActivation.OnDemand,
  'sessionTitle',
);
