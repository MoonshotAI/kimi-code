/**
 * `permission` domain (L3) — policy registry + per-agent decision service.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type Decision = 'allow' | 'deny' | 'ask';

export interface PermissionContext {
  readonly toolName: string;
  readonly args: unknown;
}

export interface PermissionPolicy {
  readonly name: string;
  evaluate(ctx: PermissionContext): Decision | undefined;
}

export interface IPermissionPolicyRegistry {
  readonly _serviceBrand: undefined;
  register(policy: PermissionPolicy): void;
  evaluate(ctx: PermissionContext): Decision;
}

export const IPermissionPolicyRegistry: ServiceIdentifier<IPermissionPolicyRegistry> =
  createDecorator<IPermissionPolicyRegistry>('permissionPolicyRegistry');

export interface IPermissionService {
  readonly _serviceBrand: undefined;
  beforeToolCall(ctx: PermissionContext): Promise<Decision>;
}

export const IPermissionService: ServiceIdentifier<IPermissionService> =
  createDecorator<IPermissionService>('permissionService');
