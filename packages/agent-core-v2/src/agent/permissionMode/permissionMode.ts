import { createDecorator } from "#/_base/di/instantiation";
import type { PermissionMode } from '#/agent/permissionPolicy/types';
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
    onDidChangeMode: PermissionModeChangedContext;
  }>;
}

export const IAgentPermissionModeService =
  createDecorator<IAgentPermissionModeService>('agentPermissionModeService');
