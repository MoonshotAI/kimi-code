import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';

import { DYNAMIC_TOOL_SCHEMA_VARIANT } from './dynamicTools';
import { IAgentToolSelectService } from './toolSelect';
import { IAgentToolSelectSchemasService } from './toolSelectSchemas';

export class AgentToolSelectSchemasService extends Service implements IAgentToolSelectSchemasService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentToolSelectService toolSelect: IAgentToolSelectService,
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
  ) {
    super();
    this._register(
      injector.register(DYNAMIC_TOOL_SCHEMA_VARIANT, () => {
        const tools = toolSelect.drainPendingToolSchemas();
        if (tools === undefined) return undefined;
        return { message: { role: 'system', content: [], tools } };
      }),
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolSelectSchemasService,
  AgentToolSelectSchemasService,
  ScopeActivation.OnScopeCreated,
  'toolSelect',
);
