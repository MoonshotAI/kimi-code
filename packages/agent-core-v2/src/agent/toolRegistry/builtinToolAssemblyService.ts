/**
 * `toolRegistry` domain — the built-in tool assembly unit.
 *
 * The one bridge from the static contribution table into the collection
 * world: constructed once at App-scope creation, it provides every
 * module-level `registerAgentToolService` contribution (import = register)
 * into the `AgentToolContribution` collection. Ancestor visibility lets
 * every Agent scope's fold (`AgentToolActivationService`) see these
 * records; withdrawing is not a built-in concept (the table is static), so
 * the records live as long as this unit. The table itself stays the static
 * data channel for the readers that only need names (profile typo
 * warnings, agent-tool descriptions). Bound at App scope.
 */

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
