import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { isUserPromptSubmitHookPart } from '#/agent/contextMemory/hookParts';
import { annotateBundledSkillParts, isSkillActivationPart } from '@moonshot-ai/core/llm/origin';
import { IAgentLoopService } from '#/agent/loop/loop';
import {
  promptMetadataTextFromContentParts,
  promptMetadataTextFromText,
} from '#/agent/prompt/promptMetadataText';
import type { ContentPart } from '@moonshot-ai/core/llm/message';
import {
  promptMetadataTextFromSkill,
  skillCommandLabel,
} from '#/features/skill/prompt';
import { IWireService } from '#/wire/wire';

import {
  IAgentTitlePromptSource,
  type TitleDigestExcerpt,
  type TitleDigestTurn,
  type TitleTurnExcerpt,
} from './agentTitlePromptSource';

export class AgentTitlePromptSourceService implements IAgentTitlePromptSource {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLoopService private readonly context: IAgentLoopService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IWireService private readonly wire: IWireService,
  ) {}

  async firstUserPrompts(limit: number): Promise<readonly string[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) return [];

    const result: string[] = [];
    const seenMessageIds = new Set<string>();

    const add = (message: ContextMessage): void => {
      if (result.length >= limit || !isUserTitlePrompt(message)) return;
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
    const firstUserIndex = all.findIndex(isUserTitlePrompt);
    if (firstUserIndex < 0) return {};
    const user = promptMetadataTextFromUserMessage(all[firstUserIndex]!);
    const rest = all.slice(firstUserIndex + 1);
    const hasSkillActivation = rest.some(
      (message) => message.origin?.kind === 'skill_activation' && message.origin.trigger === 'user-slash',
    );
    const continuationIds = hasSkillActivation ? this.turnContinuationPromptIds() : undefined;
    const span: ContextMessage[] = [];
    for (const message of rest) {
      if (isNextTurnPrompt(message, continuationIds)) break;
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
      if (!isUserTitlePrompt(message)) continue;
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
    const all = [...this.context.history()];
    const activeHandle =
      snapshot.activePromptId === undefined
        ? undefined
        : this.loop.promptHandle(snapshot.activePromptId);
    if (activeHandle !== undefined) all.push(activeHandle.message);
    for (const item of snapshot.queue) {
      if (item.attributes?.origin?.kind !== 'user') continue;
      all.push({
        role: 'user',
        content: [...item.content],
        origin: item.attributes?.origin as PromptOrigin | undefined,
      });
    }
    return all;
  }

  private turnContinuationPromptIds(): ReadonlySet<string> | undefined {
    let hasTurnPrompts = false;
    const ids = new Set<string>();
    let continuesTurn = false;
    for (const { record } of this.wire.readLoopChain()) {
      if (record.type === 'turn.ended') {
        continuesTurn = record['continuation'] === 'turn';
        continue;
      }
      if (record.type !== 'turn.prompt') continue;
      hasTurnPrompts = true;
      if (continuesTurn && typeof record['promptId'] === 'string') ids.add(record['promptId']);
      continuesTurn = false;
    }
    return hasTurnPrompts ? ids : undefined;
  }
}

function isUserTitlePrompt(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  if (origin === undefined || origin.kind === 'user') return true;
  return origin.kind === 'skill_activation' && origin.trigger === 'user-slash';
}

function isNextTurnPrompt(
  message: ContextMessage,
  continuationIds: ReadonlySet<string> | undefined,
): boolean {
  if (!isUserTitlePrompt(message)) return false;
  if (message.origin?.kind !== 'skill_activation' || continuationIds === undefined) return true;
  return message.id === undefined || !continuationIds.has(message.id);
}

function promptMetadataTextFromUserMessage(message: ContextMessage): string | undefined {
  const origin = message.origin;
  if (origin?.kind === 'skill_activation') {
    return promptMetadataTextFromSkill({
      name: origin.skillName,
      args: origin.skillArgs,
      clientMetadata: origin.clientMetadata,
    });
  }
  const bundled = origin?.kind === 'user' ? (origin.skillActivations ?? []) : [];
  const text = promptMetadataTextFromContentParts(
    annotateBundledSkillParts(message.content, bundled).filter(
      (part) => !isSkillActivationPart(part) && !isUserPromptSubmitHookPart(part),
    ),
    origin?.kind === 'user' ? origin.clientMetadata : undefined,
  );
  if (text !== undefined || bundled.length === 0) return text;
  return promptMetadataTextFromText(
    bundled.map((skill) => skillCommandLabel(skill.skillName, skill.skillArgs)).join(' '),
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
