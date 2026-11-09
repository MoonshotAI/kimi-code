import { createDecorator } from "#/_base/di/instantiation";
import type {
  PermissionData
} from '#/agent/permissionPolicy/types';

export interface IAgentPermissionGate {
  readonly _serviceBrand: undefined;

  data(): PermissionData;
}

export const IAgentPermissionGate =
  createDecorator<IAgentPermissionGate>('agentPermissionGate');
