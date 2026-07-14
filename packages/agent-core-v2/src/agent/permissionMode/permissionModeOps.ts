/**
 * `permissionMode` domain (L3) — wire Model (`PermissionModeModel`) and the
 * `permission.set_mode` Op (`setMode`) for the agent's permission mode.
 *
 * Declares the mode as a scalar `wire` Model (initial `manual`) plus a replay
 * marker that distinguishes an explicit persisted mode from the default. The
 * single Op replaces the mode and sets that marker. Consumed by the Agent-scope
 * `permissionModeService` and session bootstrap.
 */

import { z } from 'zod';

import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { defineModel } from '#/wire/model';

export const PermissionModeModel = defineModel<PermissionMode>('permissionMode', () => 'manual');
export const PermissionModeConfiguredModel = defineModel<boolean>(
  'permissionMode.configured',
  () => false,
  { reducers: { 'permission.set_mode': () => true } },
);

declare module '#/wire/types' {
  interface PersistedOpMap {
    'permission.set_mode': typeof setMode;
  }
}

export const setMode = PermissionModeModel.defineOp('permission.set_mode', {
  schema: z.object({ mode: z.custom<PermissionMode>() }),
  apply: (_s, p) => p.mode,
});
