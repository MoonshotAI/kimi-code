/**
 * `permission` domain (L3) — tool-call permission policy and decision contract.
 *
 * Defines the `Decision`, `PermissionContext`, and `PermissionPolicy` models,
 * the `IPermissionPolicyRegistry` for registering and evaluating policies, and
 * the `IPermissionService` used to decide a tool call before it runs. The
 * registry is Core-scoped; the decision service is Agent-scoped.
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
