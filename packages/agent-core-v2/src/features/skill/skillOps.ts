/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import type { SkillSource } from '#/agent/contextMemory/types';
import { AgentEvent2 } from '#/app/event/event2';

export interface SkillActivatedPayload {
  readonly agentId: string;
  readonly activationId: string;
  readonly skillName: string;
  readonly trigger: string;
  readonly skillArgs?: string;
  readonly skillPath?: string;
  readonly skillSource?: SkillSource;
}

export class SkillActivated extends AgentEvent2<SkillActivatedPayload> {
  static override readonly type = 'skill.activated';
  static override readonly observable = true;
}
export interface SkillActivated extends SkillActivatedPayload {}
