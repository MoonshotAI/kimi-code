/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { Event2 } from '#/app/event/event2';

import type { UsageStatus } from './usage';

export interface AgentStatusUpdatedPayload {
  usage?: UsageStatus;
  swarmMode?: boolean;
  towerMode?: boolean;
  planMode?: boolean;
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
