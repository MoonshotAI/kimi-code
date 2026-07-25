import { createDecorator } from "#/_base/di/instantiation";
import type {
  PermissionData
} from '#/agent/permissionPolicy/types';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';

export interface IAgentPermissionGate {
  readonly _serviceBrand: undefined;

  data(): PermissionData;
  authorize(
    context: ResolvedToolExecutionHookContext,
  ): Promise<BeforeExecuteDecision | undefined>;
}

export const IAgentPermissionGate =
  createDecorator<IAgentPermissionGate>('agentPermissionGate');
