/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { AgentEvent2 } from '#/app/event/event2';
import type { EnvironmentStatus } from '#/environment/environment';

export interface EnvironmentStatusChangedPayload {
  readonly agentId: string;
  readonly environmentId: string;
  readonly status?: EnvironmentStatus;
}

export class EnvironmentStatusChanged extends AgentEvent2<EnvironmentStatusChangedPayload> {
  static override readonly type = 'environment.status.changed';
  static override readonly observable = true;
}
export interface EnvironmentStatusChanged extends EnvironmentStatusChangedPayload {}

export interface EnvironmentStatusChangedEvent {
  readonly type: 'environment.status.changed';
  readonly environmentId: string;
  readonly status?: EnvironmentStatus;
}
