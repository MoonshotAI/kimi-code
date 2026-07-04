import type { PermissionMode } from '#/agent/permissionPolicy';
import { createDecorator } from "#/_base/di";

import type { Hooks } from '#/hooks';

export interface PermissionModeChangedContext {
  readonly mode: PermissionMode;
  readonly previousMode: PermissionMode;
}

export interface IAgentPermissionModeService {
  readonly _serviceBrand: undefined;

  readonly mode: PermissionMode;
  setMode(mode: PermissionMode): void;

  readonly hooks: Hooks<{
    onChanged: PermissionModeChangedContext;
  }>;
}

export const IAgentPermissionModeService =
  createDecorator<IAgentPermissionModeService>('agentPermissionModeService');
