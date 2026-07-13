/**
 * `skill` domain (L3) — wire Model (`SkillModel`) and the `skill.activate` Op
 * (`skillActivate`) for the agent's skill-activation fact log.
 *
 * Skill carries no state: the Model is a `null` placeholder and the Op's
 * `apply` is the identity function. `skill.activate` is live-only because it
 * is not a v1 record type; it exists to derive the `skill.activated` event and
 * carries no replayable state. The `randomUUID()` activation id is generated at
 * the dispatch call site (`skillService.recordActivation`) and carried inside
 * `origin`, keeping `apply` free of non-determinism. Also augments
 * `DomainEventMap` with `skill.activated`, derived from the Op via `toEvent`.
 * Consumed by the Agent-scope `skillService`.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

import type { SkillActivationOrigin, SkillSource } from '#/agent/contextMemory/types';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'skill.activated': {
      activationId: string;
      skillName: string;
      trigger: string;
      skillArgs?: string;
      skillPath?: string;
      skillSource?: SkillSource;
    };
  }
}

export const SkillModel = defineModel<null>('skill', () => null);

declare module '#/wire/types' {
  interface TransientOpMap {
    'skill.activate': typeof skillActivate;
  }
}

export const skillActivate = SkillModel.defineOp('skill.activate', {
  schema: z.object({ origin: z.custom<SkillActivationOrigin>() }),
  persist: false,
  apply: (s) => s,
  toEvent: (p) => ({
    type: 'skill.activated' as const,
    activationId: p.origin.activationId,
    skillName: p.origin.skillName,
    trigger: p.origin.trigger,
    skillArgs: p.origin.skillArgs,
    skillPath: p.origin.skillPath,
    skillSource: p.origin.skillSource,
  }),
});
