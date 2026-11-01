/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { Event2 } from '#/app/event/event2';

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
