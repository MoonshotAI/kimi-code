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
