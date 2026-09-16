import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import {
  promptMetadataTextFromContentParts,
  promptMetadataTextFromText,
} from '#/agent/prompt/promptMetadataText';
import type { ContentPart } from '#human/llm/message';

import {
  IAgentTitlePromptSource,
  type TitleDigestExcerpt,
  type TitleDigestTurn,
  type TitleTurnExcerpt,
} from './agentTitlePromptSource';

export class AgentTitlePromptSourceService implements IAgentTitlePromptSource {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
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
    const seenMessageIds = new Set<string>();
    const userIndexes: number[] = [];
    for (let index = 0; index < all.length; index++) {
      const message = all[index]!;
      if (!isNaturalLanguagePrompt(message)) continue;
      if (message.id !== undefined) {
        if (seenMessageIds.has(message.id)) continue;
        seenMessageIds.add(message.id);
      }
      userIndexes.push(index);
    }
    const turns: TitleDigestTurn[] = [];
    for (let i = 0; i < userIndexes.length; i++) {
      const userIndex = userIndexes[i]!;
      const user = promptMetadataTextFromUserMessage(all[userIndex]!);
      if (user === undefined) continue;
      const spanEnd = i + 1 < userIndexes.length ? userIndexes[i + 1]! : all.length;
      const assistant = finalAssistantText(all.slice(userIndex + 1, spanEnd));
      turns.push({ user, assistant });
    }
    return { turns };
  }

  private combinedMessages(): ContextMessage[] {
    const snapshot = this.loop.snapshot();
    const all = [...this.context.get()];
    const activeHandle =
      snapshot.activePromptId === undefined
        ? undefined
        : this.loop.promptHandle(snapshot.activePromptId);
    if (activeHandle !== undefined) all.push(activeHandle.message);
    for (const item of snapshot.queue) {
      if (item.meta?.tracked !== true) continue;
      all.push({
        role: 'user',
        content: [...item.message.content],
        toolCalls: [],
        origin: item.meta?.origin as PromptOrigin | undefined,
      });
    }
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
    message.origin?.kind === 'user' ? message.origin.clientMetadata : undefined,
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
