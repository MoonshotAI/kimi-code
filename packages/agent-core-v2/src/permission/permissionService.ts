/**
 * `permission` domain (L3) — `IPermissionPolicyRegistry` and
 * `IPermissionService` implementations.
 *
 * Owns the policy registry and the per-agent permission decision; requests user
 * approval through `approval`, reads agent config through `config`, records
 * through `records`, and logs through `log`. Bound at Core (policy registry)
 * and Agent (decision service) scopes.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IApprovalService } from '#/approval/approval';
import { IAgentConfigService } from '#/config/config';
import { ILogService } from '#/log/log';
import { IAgentRecords } from '#/records/records';

import {
  type Decision,
  type PermissionContext,
  type PermissionPolicy,
  IPermissionPolicyRegistry,
  IPermissionService,
} from './permission';

type PermissionMode = 'yolo' | 'manual' | 'auto';

export class PermissionPolicyRegistry implements IPermissionPolicyRegistry {
  declare readonly _serviceBrand: undefined;
  private readonly policies: PermissionPolicy[] = [];

  register(policy: PermissionPolicy): void {
    this.policies.push(policy);
  }

  evaluate(ctx: PermissionContext): Decision {
    for (const policy of this.policies) {
      const decision = policy.evaluate(ctx);
      if (decision !== undefined) return decision;
    }
    return 'allow';
  }
}

export class PermissionService implements IPermissionService {
  declare readonly _serviceBrand: undefined;
  private readonly mode: PermissionMode;

  constructor(
    @IPermissionPolicyRegistry private readonly registry: IPermissionPolicyRegistry,
    @IAgentConfigService _agentConfig: IAgentConfigService,
    @IAgentRecords _records: IAgentRecords,
    @IApprovalService private readonly approval: IApprovalService,
    @ILogService _log: ILogService,
    mode: PermissionMode = 'auto',
  ) {
    this.mode = mode;
  }

  async beforeToolCall(ctx: PermissionContext): Promise<Decision> {
    if (this.mode === 'yolo') return 'allow';
    if (this.mode === 'manual') {
      return this.approval.request({ id: ctx.toolName, toolName: ctx.toolName });
    }
    const decision = this.registry.evaluate(ctx);
    if (decision === 'ask') {
      return this.approval.request({ id: ctx.toolName, toolName: ctx.toolName });
    }
    return decision;
  }
}

registerScopedService(LifecycleScope.Core, IPermissionPolicyRegistry, PermissionPolicyRegistry, InstantiationType.Delayed, 'permission');
registerScopedService(LifecycleScope.Agent, IPermissionService, PermissionService, InstantiationType.Delayed, 'permission');
