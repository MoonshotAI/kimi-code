/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { AgentEvent2 } from '#/app/event/event2';

export class ContextUndone extends AgentEvent2<{ readonly agentId: string; readonly turns: number }> {
  static override readonly type = 'context.undone';
  static override readonly observable = true;
}
export interface ContextUndone {
  readonly agentId: string;
  readonly turns: number;
}
