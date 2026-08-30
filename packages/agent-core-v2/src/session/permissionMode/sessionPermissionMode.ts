import { createDecorator } from '#/_base/di/instantiation';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { WirePermissionMode } from '#/actor/permissionMode/permissionModeOps';

export interface ISessionPermissionModeService {
  readonly _serviceBrand: undefined;

  mode(agent: AgentContext): WirePermissionMode;
  configured(agent: AgentContext): boolean;
  setMode(agent: AgentContext, mode: WirePermissionMode): void;
  setModeAndBroadcast(agent: AgentContext, mode: WirePermissionMode): void;
}

export const ISessionPermissionModeService = createDecorator<ISessionPermissionModeService>(
  'sessionPermissionModeService',
);
