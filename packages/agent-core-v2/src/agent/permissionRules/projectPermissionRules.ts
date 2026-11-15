import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { PermissionRule } from './permissionRules';

export interface IProjectPermissionRulesService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly rules: readonly PermissionRule[];
  appendRules(rules: readonly PermissionRule[]): Promise<void>;
}

export const IProjectPermissionRulesService: ServiceIdentifier<IProjectPermissionRulesService> =
  createDecorator<IProjectPermissionRulesService>('projectPermissionRulesService');
