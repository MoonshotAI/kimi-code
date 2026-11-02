/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import type { PromptQueuedPayload } from '#/agent/prompt/promptEvents';
import { AgentEvent2, Event2 } from '#/app/event/event2';

import type { PromptQueueSnapshot } from './promptQueue';

export interface PromptQueueChangedPayload {
  readonly sessionId: string;
  readonly agentId: string;
  readonly snapshot: PromptQueueSnapshot;
}

export class PromptQueueChanged extends Event2<{ readonly payload: PromptQueueChangedPayload }> {
  static override readonly type = 'prompt_queue.changed';
}
export interface PromptQueueChanged {
  readonly payload: PromptQueueChangedPayload;
}

export class PromptHeld extends AgentEvent2<PromptQueuedPayload> {
  static override readonly type = 'prompt_queue.held';
  static override readonly observable = true;
}
export interface PromptHeld extends PromptQueuedPayload {}
