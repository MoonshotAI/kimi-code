/**
 * `skill` domain (L3) — wire Model (`SkillModel`) and the `skill.activate` Op
 * (`skillActivate`) for the agent's skill-activation fact log.
 *
 * Skill carries no state: the Model is a `null` placeholder and the Op's
 * `apply` is the identity function, so the record is a pure fact log ("this
 * skill was activated") whose only effect is persistence — `wire.replay`
 * applies it as a no-op. The `randomUUID()` activation id is generated at the
 * dispatch call site (`skillService.recordActivation`) and carried inside
 * `origin`, keeping `apply` free of non-determinism. Also augments `DomainEventMap`
 * with `skill.activated`, derived from the Op via `toEvent`. Consumed by the
 * Agent-scope `skillService`.
 */

import { defineModel, defineOp } from '#/wire';

import type { SkillActivationOrigin, SkillSource } from '#/agent/contextMemory';

declare module '#/wire' {
  interface SignalMap {
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

export const skillActivate = defineOp(SkillModel, 'skill.activate', {
  apply: (s, _p: { origin: SkillActivationOrigin }) => s,
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
