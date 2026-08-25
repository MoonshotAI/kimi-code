/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';

export type WirePermissionMode = 'manual' | 'yolo' | 'auto';

export interface PermissionModeState {
  readonly mode: WirePermissionMode;
  readonly configured: boolean;
}

const permissionSetModeSchema = z.object({
  agentId: z.string(),
  mode: z.custom<WirePermissionMode>(),
});

export class PermissionSetMode extends AgentEvent2<z.infer<typeof permissionSetModeSchema>> {
  static override readonly type = 'permission.set_mode';
  static override readonly durable = true;
  static override readonly schema = permissionSetModeSchema;
}
export interface PermissionSetMode {
  readonly agentId: string;
  readonly mode: WirePermissionMode;
}
