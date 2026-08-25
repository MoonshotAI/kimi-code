/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import type { KimiErrorPayload } from '#/_base/errors/serialize';
import { AgentEvent2, type AgentDomainTrait } from '#/app/event/event2';

export class AgentErrorEvent extends AgentEvent2<KimiErrorPayload & AgentDomainTrait> {
  static override readonly type = 'error';
  static override readonly observable = true;
}
export interface AgentErrorEvent extends KimiErrorPayload {
  readonly agentId: string;
}
