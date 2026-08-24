/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import type { SkillActivationOrigin, SkillSource } from '#/agent/contextMemory/types';
import { AgentEvent2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

export interface SkillActivatePayload {
  readonly agentId: string;
  readonly origin: SkillActivationOrigin;
}

export class SkillActivate extends AgentEvent2<SkillActivatePayload> {
  static override readonly type = 'skill.activate';
}
export interface SkillActivate extends SkillActivatePayload {}

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

export const skillKey = defineState('skill', (): null => null)
  .replayable({ schema: z.custom<null>(), durable: false })
  .on(SkillActivate, (_s, e, ctx) => {
  ctx.emit(
    new SkillActivated({
      agentId: e.agentId,
      activationId: e.origin.activationId,
      skillName: e.origin.skillName,
      trigger: e.origin.trigger,
      skillArgs: e.origin.skillArgs,
      skillPath: e.origin.skillPath,
      skillSource: e.origin.skillSource,
    }),
  );
});
