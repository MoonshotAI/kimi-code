import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

import { AgentToolContribution, getAgentToolContributions } from './toolContribution';

export interface IBuiltinToolAssemblyService {
  readonly _serviceBrand: undefined;
}

export const IBuiltinToolAssemblyService = createDecorator<IBuiltinToolAssemblyService>(
  'builtinToolAssemblyService',
);

export class BuiltinToolAssemblyService extends Service implements IBuiltinToolAssemblyService {
  declare readonly _serviceBrand: undefined;

  constructor() {
    super();
    for (const record of getAgentToolContributions()) {
      this.provide(AgentToolContribution, record);
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  IBuiltinToolAssemblyService,
  BuiltinToolAssemblyService,
  ScopeActivation.OnScopeCreated,
  'toolRegistry',
);
