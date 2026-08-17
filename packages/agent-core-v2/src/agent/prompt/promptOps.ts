/**
 * `prompt` domain — persists the accepted prompt identities used for
 * same-agent uniqueness checks.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

export type PromptAdmissionModelState = Map<string, true>;

export const PromptAdmissionModel = defineModel<PromptAdmissionModelState>(
  'promptAdmission',
  () => new Map(),
);

declare module '#/wire/types' {
  interface PersistedOpMap {
    'prompt.accepted': typeof promptAccepted;
  }
}

export const promptAccepted = PromptAdmissionModel.defineOp('prompt.accepted', {
  schema: z.object({ promptId: z.string().min(1) }),
  apply: (state, { promptId }) => {
    if (state.has(promptId)) return state;
    return new Map([...state, [promptId, true] as const]);
  },
});
