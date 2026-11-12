/**
 * Loop input contract: the snapshot used to construct or reset a loop (profile, history, inbox,
 * unfinished turn) and the command union accepted from the host.
 */
import type { Message, UserMessage } from '#/llm/message';
import type { RemindMessage, TurnTrigger } from './inbox';
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
  readonly messages?: readonly Message[];
  readonly inbox?: {
    readonly normal?: readonly UserMessage[];
    readonly notify?: readonly UserMessage[];
    readonly remind?: readonly RemindMessage[];
  };
  readonly nextTurnId?: number;
  readonly historyRevision?: number;
  readonly unfinished?: UnfinishedTurn;
}

export type LoopCommand =
  | { type: 'input.run_turn'; message: UserMessage }
  | { type: 'input.submit'; message: UserMessage }
  | { type: 'input.cancel'; promptId: string }
  | { type: 'input.steer'; promptIds: readonly string[] }
  | { type: 'input.notify'; message: UserMessage }
  | { type: 'input.remind'; message: RemindMessage }
  | { type: 'input.abort_tool'; toolCallId: string }
  | { type: 'input.detach_tool'; toolCallId: string }
  | { type: 'input.set_context'; messages: Message[] }
  | { type: 'input.set_system_prompt'; systemPrompt: string };
