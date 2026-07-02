import type {
  PermissionData,
} from '#/agent/permissionPolicy';
import { createDecorator } from "#/_base/di";
import type {
  AuthorizeToolExecutionResult,
  ResolvedToolExecutionHookContext,
} from '#/agent/tool';

export interface PermissionGateOptions {
  readonly agentId?: string;
}

export interface IAgentPermissionGate {
  readonly _serviceBrand: undefined;
  data(): PermissionData;
  authorize(
    context: ResolvedToolExecutionHookContext,
  ): Promise<AuthorizeToolExecutionResult | undefined>;
}

export const IAgentPermissionGate =
  createDecorator<IAgentPermissionGate>('agentPermissionGate');
