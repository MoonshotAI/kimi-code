/**
 * `skill` domain — the `skillKey` placeholder state, the transient
 * `skill.activate` event (`SkillActivate`), and the observable
 * `skill.activated` fact (`SkillActivated`).
 *
 * Skill carries no state: `skillKey` is a `null` placeholder whose fold
 * exists to emit `SkillActivated` live (dropped on replay, so neither the
 * event nor telemetry fires on resume, matching the former `restoring`
 * guard). `skill.activate` is live-only because it is not a v1 record type.
 * The `randomUUID()` activation id is generated at the dispatch call site and
 * carried inside `origin`, keeping the fold free of non-determinism.
 * Scope-agnostic.
 */

/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

import { z } from 'zod';

import type { SkillActivationOrigin, SkillSource } from '#/agent/contextMemory/types';
import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

export interface SkillActivatePayload {
  readonly origin: SkillActivationOrigin;
}

export class SkillActivate extends Event2<SkillActivatePayload> {
  static override readonly type = 'skill.activate';
}
export interface SkillActivate extends SkillActivatePayload {}

export interface SkillActivatedPayload {
  readonly activationId: string;
  readonly skillName: string;
  readonly trigger: string;
  readonly skillArgs?: string;
  readonly skillPath?: string;
  readonly skillSource?: SkillSource;
}

export class SkillActivated extends Event2<SkillActivatedPayload> {
  static override readonly type = 'skill.activated';
  static override readonly observable = true;
}
export interface SkillActivated extends SkillActivatedPayload {}

export const skillKey = defineState('skill', (): null => null)
  .replayable({ schema: z.custom<null>(), durable: false })
  .on(SkillActivate, (_s, e, ctx) => {
  ctx.emit(
    new SkillActivated({
      activationId: e.origin.activationId,
      skillName: e.origin.skillName,
      trigger: e.origin.trigger,
      skillArgs: e.origin.skillArgs,
      skillPath: e.origin.skillPath,
      skillSource: e.origin.skillSource,
    }),
  );
});
