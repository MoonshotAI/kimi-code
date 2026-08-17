import { z } from 'zod';

import type { RuntimeBinding } from '#/runtime/runtime';
import { defineModel } from '#/wire/model';

export const RuntimeBindingModel = defineModel<RuntimeBinding | undefined>(
  'runtimeBinding',
  () => undefined,
);

declare module '#/wire/types' {
  interface PersistedOpMap {
    'runtime.set_binding': typeof setRuntimeBinding;
  }
}

export const setRuntimeBinding = RuntimeBindingModel.defineOp('runtime.set_binding', {
  schema: z.object({ workspaceId: z.string(), runtimeId: z.string() }),
  apply: (_state, binding) => binding,
});
