import type { HistoryMessage, UserEntry } from '#/history/message';
import type { ToolDescription } from '#/llm/message';
import { isEntry, isObject } from '../guards';
import type { LoopAck } from './emitted';
import type { RemindEntry, TurnTrigger } from './inbox';
import type { TurnOutcome } from './outcome';

export interface UnfinishedTurn {
  readonly turnId: number;
  readonly trigger: TurnTrigger;
  readonly step: number;
  readonly stepUnfinished: boolean;
  readonly appended: boolean;
}

export interface LoopProfile {
  readonly systemPrompt?: string;
  readonly tools?: readonly ToolDescription[];
}

export interface LoopInput {
  readonly profile?: LoopProfile;
  readonly messages?: readonly HistoryMessage[];
  readonly inbox?: {
    readonly normal?: readonly UserEntry[];
    readonly notify?: readonly UserEntry[];
    readonly remind?: readonly RemindEntry[];
  };
  readonly nextTurnId?: number;
  readonly unfinished?: UnfinishedTurn;
}

export type TurnReply = (outcome?: TurnOutcome) => void;

export type LoopCommand =
  | { type: 'input.run_turn'; entry: UserEntry; reply: TurnReply }
  | { type: 'input.submit'; entry: UserEntry; reply?: (event: LoopAck<'prompt.submitted'>) => void }
  | { type: 'input.cancel'; promptId: string; reply?: (event: LoopAck<'prompt.canceled'>) => void }
  | { type: 'input.steer'; promptIds: readonly string[]; reply?: (event: LoopAck<'prompt.steered'>) => void }
  | { type: 'input.notify'; entry: UserEntry; reply?: (event: LoopAck<'prompt.notified'>) => void }
  | { type: 'input.remind'; entry: RemindEntry; reply?: (event: LoopAck<'prompt.reminded'>) => void }
  | { type: 'input.abort_turn'; reason?: unknown }
  | { type: 'input.abort_tool'; toolCallId: string; reason?: unknown }
  | { type: 'input.detach_tool'; toolCallId: string }
  | {
      type: 'input.set_context';
      messages: HistoryMessage[];
      reason?: string;
      reply?: (event: LoopAck<'context.settled' | 'context.rejected'>) => void;
    }
  | {
      type: 'input.set_system_prompt';
      systemPrompt?: string;
      reply?: (event: LoopAck<'system_prompt.settled' | 'system_prompt.rejected'>) => void;
    }
  | {
      type: 'input.set_tools';
      tools: readonly ToolDescription[];
      reply?: (event: LoopAck<'tools.settled' | 'tools.rejected'>) => void;
    }
  | { type: 'input.continue' }
  | { type: 'input.close' };

function isUserEntry(value: unknown): value is UserEntry {
  return isEntry(value) && value.message.role === 'user';
}

function isRemindEntry(value: unknown): value is RemindEntry {
  return isEntry(value) && (value.message.role === 'user' || value.message.role === 'system');
}

function arrayOf(value: unknown, guard: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(guard);
}

function isCount(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isUnfinishedTurn(value: unknown): value is UnfinishedTurn {
  if (!isObject(value)) return false;
  return (
    isCount(value['turnId']) &&
    (value['trigger'] === 'normal' || value['trigger'] === 'notify' || value['trigger'] === 'continue') &&
    isCount(value['step']) &&
    typeof value['stepUnfinished'] === 'boolean' &&
    typeof value['appended'] === 'boolean'
  );
}

function isToolDescription(value: unknown): value is ToolDescription {
  return (
    isObject(value) &&
    typeof value['name'] === 'string' &&
    typeof value['description'] === 'string' &&
    isObject(value['parameters'])
  );
}

function isProfile(value: unknown): value is LoopProfile {
  return (
    isObject(value) &&
    (value['systemPrompt'] === undefined || typeof value['systemPrompt'] === 'string') &&
    (value['tools'] === undefined || arrayOf(value['tools'], isToolDescription))
  );
}

export function inputError(input: LoopInput): string | undefined {
  if (input.messages !== undefined && !arrayOf(input.messages, isEntry)) {
    return 'messages must be an array of history entries';
  }
  const inbox = input.inbox ?? {};
  if (inbox.normal !== undefined && !arrayOf(inbox.normal, isUserEntry)) {
    return 'inbox.normal must be an array of user entries';
  }
  if (inbox.notify !== undefined && !arrayOf(inbox.notify, isUserEntry)) {
    return 'inbox.notify must be an array of user entries';
  }
  if (inbox.remind !== undefined && !arrayOf(inbox.remind, isRemindEntry)) {
    return 'inbox.remind must be an array of user or system entries';
  }
  if (input.nextTurnId !== undefined && !isCount(input.nextTurnId)) {
    return 'nextTurnId must be a non-negative integer';
  }
  if (input.unfinished !== undefined && !isUnfinishedTurn(input.unfinished)) {
    return 'unfinished must describe an unfinished turn';
  }
  if (input.profile !== undefined && !isProfile(input.profile)) {
    return 'profile must be a system prompt and an array of tool descriptions';
  }
  return undefined;
}

export function commandError(command: LoopCommand): string | undefined {
  switch (command.type) {
    case 'input.run_turn':
    case 'input.submit':
    case 'input.notify':
      return isUserEntry(command.entry) ? undefined : 'entry must be a user entry';
    case 'input.remind':
      return isRemindEntry(command.entry) ? undefined : 'entry must be a user or system entry';
    case 'input.steer':
      return arrayOf(command.promptIds, (id) => typeof id === 'string')
        ? undefined
        : 'promptIds must be an array of strings';
    case 'input.cancel':
      return typeof command.promptId === 'string' ? undefined : 'promptId must be a string';
    case 'input.abort_tool':
    case 'input.detach_tool':
      return typeof command.toolCallId === 'string' ? undefined : 'toolCallId must be a string';
    case 'input.set_context':
      return arrayOf(command.messages, isEntry) ? undefined : 'messages must be an array of history entries';
    case 'input.set_system_prompt':
      return command.systemPrompt === undefined || typeof command.systemPrompt === 'string'
        ? undefined
        : 'systemPrompt must be a string';
    case 'input.set_tools':
      return arrayOf(command.tools, isToolDescription) ? undefined : 'tools must be an array of tool descriptions';
    default:
      return undefined;
  }
}
