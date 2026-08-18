/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { Event2 } from '#/app/event/event2';

import type { UsageStatus } from './usage';

export interface AgentFlowRunStatus {
  flowId: string;
  stageId: string;
  stageIndex: number;
  stageTotal: number;
  gate: string;
}

export interface AgentStatusUpdatedPayload {
  usage?: UsageStatus;
  swarmMode?: boolean;
  towerMode?: boolean;
  planMode?: boolean;
  flowRun?: AgentFlowRunStatus | null;
  model?: string;
  thinkingEffort?: string;
  maxContextTokens?: number;
  contextTokens?: number;
}

export class AgentStatusUpdated extends Event2<AgentStatusUpdatedPayload> {
  static override readonly type = 'agent.status.updated';
  static override readonly observable = true;
}
export interface AgentStatusUpdated extends AgentStatusUpdatedPayload {}
