import type { HistoryMessage, UserEntry } from '#human/agent/turn';
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
  readonly historyRevision?: number;
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
  | { type: 'input.set_system_prompt'; systemPrompt: string };
