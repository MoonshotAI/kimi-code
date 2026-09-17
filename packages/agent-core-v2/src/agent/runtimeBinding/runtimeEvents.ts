/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { AgentEvent2 } from '#/app/event/event2';
import type { RuntimeStatus } from '#/runtime/runtime';

export interface RuntimeStatusChangedPayload {
  readonly agentId: string;
  readonly runtimeId: string;
  readonly status?: RuntimeStatus;
}

export class RuntimeStatusChanged extends AgentEvent2<RuntimeStatusChangedPayload> {
  static override readonly type = 'runtime.status.changed';
  static override readonly observable = true;
}
export interface RuntimeStatusChanged extends RuntimeStatusChangedPayload {}

export interface RuntimeStatusChangedEvent {
  readonly type: 'runtime.status.changed';
  readonly runtimeId: string;
  readonly status?: RuntimeStatus;
}
