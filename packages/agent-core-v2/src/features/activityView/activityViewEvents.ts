/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { AgentEvent2, type AgentDomainTrait } from '#/app/event/event2';

import type { AgentActivityState } from './types';

export class AgentActivityUpdated extends AgentEvent2<AgentActivityState & AgentDomainTrait> {
  static override readonly type = 'agent.activity.updated';
  static override readonly observable = true;
}
export interface AgentActivityUpdated extends AgentActivityState {
  readonly agentId: string;
}
