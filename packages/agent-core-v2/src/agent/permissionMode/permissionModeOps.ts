/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { AgentEvent2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

const permissionSetModeSchema = z.object({
  agentId: z.string(),
  mode: z.custom<PermissionMode>(),
});

export class PermissionSetMode extends AgentEvent2<z.infer<typeof permissionSetModeSchema>> {
  static override readonly type = 'permission.set_mode';
  static override readonly durable = true;
  static override readonly schema = permissionSetModeSchema;
}
export interface PermissionSetMode {
  readonly agentId: string;
  readonly mode: PermissionMode;
}

export const permissionModeKey = defineState('permissionMode', (): PermissionMode => 'manual')
  .replayable({ schema: z.custom<PermissionMode>() })
  .on(PermissionSetMode, (_s, e) => e.mode);

export const permissionModeConfiguredKey = defineState(
  'permissionMode.configured',
  (): boolean => false,
)
  .replayable({ schema: z.custom<boolean>() })
  .on(PermissionSetMode, () => true);
