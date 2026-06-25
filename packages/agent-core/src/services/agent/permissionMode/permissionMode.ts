import type { PermissionMode } from '../../../agent/permission';
import { createDecorator } from '../../../di';

import type { Hooks } from '../hooks';

export interface PermissionModeChangedContext {
  readonly mode: PermissionMode;
  readonly previousMode: PermissionMode;
}

export interface IPermissionModeService {
  readonly mode: PermissionMode;
  setMode(mode: PermissionMode): void;

  readonly hooks: Hooks<{
    onChanged: PermissionModeChangedContext;
  }>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IPermissionModeService =
  createDecorator<IPermissionModeService>('agentPermissionModeService');
