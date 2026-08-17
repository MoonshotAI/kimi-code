/**
 * `permissionMode` domain — the `permissionModeKey` /
 * `permissionModeConfiguredKey` states and the durable `permission.set_mode`
 * event (`PermissionSetMode`) for the agent's permission mode.
 *
 * Declares the mode as a scalar state (initial `manual`) plus a replay marker
 * state that distinguishes an explicit persisted mode from the default. The
 * single durable event replaces the mode and sets the marker; both states fold
 * it. Scope-agnostic.
 */

/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

import { z } from 'zod';

import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

const permissionSetModeSchema = z.object({ mode: z.custom<PermissionMode>() });

export class PermissionSetMode extends Event2<z.infer<typeof permissionSetModeSchema>> {
  static override readonly type = 'permission.set_mode';
  static override readonly durable = true;
  static override readonly schema = permissionSetModeSchema;
}
export interface PermissionSetMode extends z.infer<typeof permissionSetModeSchema> {}

export const permissionModeKey = defineState('permissionMode', (): PermissionMode => 'manual')
  .replayable({ schema: z.custom<PermissionMode>() })
  .on(PermissionSetMode, (_s, e) => e.mode);

export const permissionModeConfiguredKey = defineState(
  'permissionMode.configured',
  (): boolean => false,
)
  .replayable({ schema: z.custom<boolean>() })
  .on(PermissionSetMode, () => true);
