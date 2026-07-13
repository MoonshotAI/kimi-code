import { createDecorator } from "#/_base/di/instantiation";
import type { Event } from '#/_base/event';
import type { PermissionMode } from '#/agent/permissionPolicy/types';

export interface PermissionModeChangedContext {
  readonly mode: PermissionMode;
  readonly previousMode: PermissionMode;
}

export interface IAgentPermissionModeService {
  readonly _serviceBrand: undefined;

  readonly mode: PermissionMode;
  setMode(mode: PermissionMode): void;

  /** Fires when the effective mode actually changes (no-op re-dispatch stays silent). */
  readonly onDidChangeMode: Event<PermissionModeChangedContext>;
}

export const IAgentPermissionModeService =
  createDecorator<IAgentPermissionModeService>('agentPermissionModeService');
