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

import type { PermissionMode } from '#/agent/permissionPolicy';
import { defineModel, defineOp } from '#/wire';

export const PermissionModeModel = defineModel<PermissionMode>('permissionMode', () => 'manual');

export const setMode = defineOp(PermissionModeModel, 'permission.set_mode', {
  apply: (_s, p: { mode: PermissionMode }) => p.mode,
});
