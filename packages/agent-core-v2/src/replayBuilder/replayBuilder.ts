import { createDecorator } from "#/_base/di";
import type { AgentReplayRecord, AgentReplayRecordPayload } from '../../../rpc/resumed';

import type { ContextMessage, WireRecord } from '../types';

export interface ReplayRangeOptions {
  readonly start?: number;
  readonly count?: number;
}

export interface ReplayBuilderServiceOptions {
  readonly range?: ReplayRangeOptions;
}

export interface IReplayBuilderService {
  readonly _serviceBrand: undefined;

  postRestoring: boolean;
  captureLiveRecords: boolean;

  push(record: AgentReplayRecordPayload): void;
  patchLast<T extends AgentReplayRecord['type']>(
    type: T,
    patch: Partial<Extract<AgentReplayRecord, { type: T }>>,
  ): void;
  removeLastMessages(removedMessages: ReadonlySet<ContextMessage>): void;
  finishRestoringRecord(record: WireRecord): boolean;
  buildResult(): readonly AgentReplayRecord[];
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IReplayBuilderService = createDecorator<IReplayBuilderService>(
  'agentReplayBuilderService',
);
