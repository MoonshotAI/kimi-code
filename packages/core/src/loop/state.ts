import { annotateBundledSkillParts, type UserPromptOrigin } from '#/llm/origin';
import type { Message, ToolCall, ToolMessage, UserMessage } from '#/llm/message';
import type { Inbox } from './contract/inbox';
import type { LoopProfile } from './contract/profile';
import type { LoopRecordState } from './record';
import type { TurnState } from './turn';
import type { LiveTool } from './live';

export type LoopTurn = Pick<TurnState, 'id' | 'trigger' | 'step' | 'bypassMaxSteps'>;

export type LoopToolCall = Pick<LiveTool, 'toolCall' | 'turnId' | 'detached'>;

export interface LoopState {
  readonly status: 'idle' | 'running' | 'interrupted';
  readonly held: boolean;
  readonly resetting: boolean;
  readonly inbox: Readonly<Inbox>;
  readonly profile: LoopProfile;
  readonly messages: readonly Message[];
  readonly nextTurnId: number;
  readonly turn?: LoopTurn;
  readonly calls: readonly LoopToolCall[];
  readonly completionPending: boolean;
}

export function canContinue(messages: readonly Message[]): boolean {
  const role = messages.at(-1)?.role;
  return role === 'user' || role === 'tool';
}

export function trailingCalls(messages: readonly Message[]): { unresolved: ToolCall[]; stopped: boolean } {
  const index = messages.findLastIndex((message) => message.role === 'assistant');
  const assistant = messages[index];
  if (assistant?.role !== 'assistant') return { unresolved: [], stopped: false };
  const after = messages.slice(index + 1);
  const results = after.filter((message): message is ToolMessage => message.role === 'tool');
  const answered = new Set(results.map((message) => message.toolCallId));
  return {
    unresolved: assistant.toolCalls.filter((toolCall) => !answered.has(toolCall.id)),
    stopped: results.length === after.length && results.some((message) => message.attributes?.stopTurn === true),
  };
}

export function isResumable(durable: LoopRecordState): boolean {
  if (durable.unfinished?.appended !== true) return false;
  const { unresolved, stopped } = trailingCalls(durable.messages);
  return !stopped && (unresolved.length > 0 || canContinue(durable.messages));
}

export function normalizeUserMessage(message: UserMessage): UserMessage {
  const origin = message.attributes?.origin;
  return {
    ...message,
    content: origin?.kind === 'user'
      ? annotateBundledSkillParts(message.content, (origin as UserPromptOrigin).skillActivations ?? [])
      : [...message.content],
  };
}
