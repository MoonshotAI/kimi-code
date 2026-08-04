/**
 * `skillDisclosure` domain (L4) — persistent disclosed-skill names model.
 *
 * Defines the Agent wire model and whole-set replacement operation used to
 * restore the system-prompt skill baseline across replay and forks. Alongside
 * the names, the model records the render generation of the disclosure that
 * wrote them (renders, binding snapshots, and runtime seeds), so reminder
 * baselines can order the floor against in-context reminder disclosures. A
 * newer render advances the stored generation even when its name set is
 * unchanged.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

export interface SkillDisclosureModelState {
  readonly names?: readonly string[];
  readonly renderGeneration?: number;
}

export const SkillDisclosureModel = defineModel<SkillDisclosureModelState>(
  'skillDisclosure',
  () => ({}),
);

export const setDisclosedSkills = SkillDisclosureModel.defineOp('skill.disclosure.set', {
  schema: z.object({
    names: z.array(z.string()).readonly(),
    renderGeneration: z.number().optional(),
  }),
  apply: (state, payload) => {
    const renderGeneration = payload.renderGeneration ?? 0;
    return stringArrayEqual(state.names, payload.names) &&
      (state.renderGeneration ?? 0) === renderGeneration
      ? state
      : { names: payload.names, renderGeneration };
  },
});

function stringArrayEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

declare module '#/wire/types' {
  interface PersistedOpMap {
    'skill.disclosure.set': typeof setDisclosedSkills;
  }
}
