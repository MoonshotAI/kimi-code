/**
 * `permissionMode` domain (L3) — wire Model (`PermissionModeModel`) and the
 * `permission.set_mode` Op (`setMode`) for the agent's permission mode.
 *
 * Declares the mode as a scalar `wire` Model (initial `manual`) plus the single
 * Op that replaces it; `defineOp` registers the Op into the global registry at
 * import, so `wire.dispatch(setMode({ mode }))` mutates the model and
 * `wire.replay` rebuilds it from persisted records (skipping every other record
 * type). Consumed by the Agent-scope `permissionModeService`.
 */

import { z } from 'zod';

import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { defineModel } from '#/wire/model';

export const PermissionModeModel = defineModel<PermissionMode>('permissionMode', () => 'manual');

declare module '#/wire/types' {
  interface PersistedOpMap {
    'permission.set_mode': typeof setMode;
  }
}

export const setMode = PermissionModeModel.defineOp('permission.set_mode', {
  schema: z.object({ mode: z.custom<PermissionMode>() }),
  apply: (_s, p) => p.mode,
});
