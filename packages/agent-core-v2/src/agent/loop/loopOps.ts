/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { AgentEvent2 } from '#/app/event/event2';

export interface LoopLifecyclePayload {
  readonly agentId: string;
}

export class LoopDrained extends AgentEvent2<LoopLifecyclePayload> {
  static override readonly type = 'loop.drained';
  static override readonly observable = true;
}
export interface LoopDrained extends LoopLifecyclePayload {}

export class LoopIdle extends AgentEvent2<LoopLifecyclePayload> {
  static override readonly type = 'loop.idle';
  static override readonly observable = true;
}
export interface LoopIdle extends LoopLifecyclePayload {}

export interface LoopDrainedEvent {
  readonly type: 'loop.drained';
  readonly time?: number;
}

export interface LoopIdleEvent {
  readonly type: 'loop.idle';
  readonly time?: number;
}
