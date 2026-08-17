/**
 * `usage` domain — the shared `agent.status.updated` fan-in event.
 *
 * One observable transient `Event2` carrying optional status slices; each
 * owning domain emits its own slice (usage, plan/swarm mode, model, context
 * tokens) after its state commits, live only — replay never emits it.
 * Scope-agnostic.
 */

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
