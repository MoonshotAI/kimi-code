import type { PermissionMode } from '#/permissionPolicy';
import { createDecorator } from "#/_base/di";

import type { Hooks } from '../hooks';

export interface PermissionModeChangedContext {
  readonly mode: PermissionMode;
  readonly previousMode: PermissionMode;
}

export interface IPermissionModeService {
  readonly _serviceBrand: undefined;
  readonly mode: PermissionMode;
  setMode(mode: PermissionMode): void;

  readonly hooks: Hooks<{
    onChanged: PermissionModeChangedContext;
  }>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IPermissionModeService =
  createDecorator<IPermissionModeService>('agentPermissionModeService');
