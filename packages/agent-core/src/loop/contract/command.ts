import type { HistoryMessage, UserEntry } from '#/history/message';
import type { ToolDescription } from '#/llm/message';
import { isEntry, isObject } from '../guards';
import type { RemindEntry, TurnTrigger } from './inbox';
import type { LoopProfile } from './profile';

export interface UnfinishedTurn {
  readonly turnId: number;
  readonly trigger: TurnTrigger;
  readonly step: number;
  readonly stepUnfinished: boolean;
  readonly appended: boolean;
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

export type LoopCommand =
  | { type: 'input.run_turn'; entry: UserEntry }
  | { type: 'input.submit'; entry: UserEntry }
  | { type: 'input.cancel'; promptId: string }
  | { type: 'input.steer'; promptIds: readonly string[] }
  | { type: 'input.notify'; entry: UserEntry }
  | { type: 'input.remind'; entry: RemindEntry }
  | { type: 'input.abort_tool'; toolCallId: string }
  | { type: 'input.detach_tool'; toolCallId: string }
  | { type: 'input.set_context'; messages: HistoryMessage[] }
  | { type: 'input.set_system_prompt'; systemPrompt: string }
  | { type: 'input.set_tools'; tools: readonly ToolDescription[] };

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

const SYSTEM_PROMPT_ERROR = 'systemPrompt must be a string';
const TOOLS_ERROR = 'tools must be an array of tool descriptions';

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
  const profile = input.profile ?? {};
  if (profile.systemPrompt !== undefined && typeof profile.systemPrompt !== 'string') return SYSTEM_PROMPT_ERROR;
  if (profile.tools !== undefined && !arrayOf(profile.tools, isToolDescription)) return TOOLS_ERROR;
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
      return typeof command.systemPrompt === 'string' ? undefined : SYSTEM_PROMPT_ERROR;
    case 'input.set_tools':
      return arrayOf(command.tools, isToolDescription) ? undefined : TOOLS_ERROR;
    default:
      return undefined;
  }
}
