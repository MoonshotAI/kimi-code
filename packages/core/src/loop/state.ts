import { annotateBundledSkillParts, type UserPromptOrigin } from '#/llm/origin';
import type { Message, ToolCall, ToolMessage, UserMessage } from '#/llm/message';
import type { ToolExecutionHandler, ToolResult } from '#/tool/types';
import type { Inbox, MessageSource, QueuedItem, TurnTrigger } from './contract/inbox';
import type { AsyncToolOutcome, Cause, TurnOutcome } from './contract/outcome';
import type { LoopProfile } from './contract/profile';
import type { HookFailure } from '#/hook/loop/failure';
import type { LoopRecordState } from './record';
import type { ToolCompletionFactory } from './tool/outcome';
import type { Turn } from './turn';

export type LoopPhase = 'idle' | 'running' | 'closed';

export interface LoopTurn {
  readonly id: number;
  readonly trigger: TurnTrigger;
  readonly step: number;
  readonly bypassMaxSteps?: boolean;
}

export interface LoopToolCall {
  readonly toolCall: ToolCall;
  readonly turnId: number;
  readonly detached: boolean;
}

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

export interface TurnCompletion {
  readonly promise: Promise<TurnOutcome>;
  resolve(outcome: TurnOutcome): void;
}

export interface LiveTurn {
  readonly id: number;
  readonly trigger: TurnTrigger;
  readonly machine: Turn;
  pending: QueuedItem[];
  readonly promptOnly?: true;
  readonly resumed?: true;
  announced: boolean;
  readonly completion?: TurnCompletion;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
  outcome?: TurnOutcome;
  continueAfterAbort?: boolean;
}

export interface LiveTool {
  readonly key: string;
  toolCall: ToolCall;
  readonly turnId: number;
  readonly step: number;
  readonly handler: ToolExecutionHandler;
  detached: boolean;
  announced: boolean;
  responded: boolean;
  done: boolean;
  result?: ToolResult;
  completion?: ToolCompletionFactory;
  completionMessage?: Promise<UserMessage>;
  completionMessageValue?: UserMessage;
  completionOutcome?: AsyncToolOutcome;
  completionPending?: boolean;
  readonly waiters: Set<() => void>;
}

export type AppendedItem =
  | { source: MessageSource; message: Message; blocked?: Cause }
  | { source: 'notify'; message: UserMessage; failure: HookFailure };

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
