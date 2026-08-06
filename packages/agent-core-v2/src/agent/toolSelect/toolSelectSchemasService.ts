/**
 * `toolSelect` domain — `IAgentToolSelectSchemasService` implementation.
 *
 * Registers dynamic-tool schema declarations as a `contextInjector`
 * provider (variant `dynamic_tool_schema`): every injection boundary drains
 * the tools `toolSelect` marked loaded since the last declaration and
 * appends them as a `role: 'system'` raw injection message whose `tools`
 * field carries the full definitions, so the declaration lands at a
 * quiescent boundary instead of mid-step inside a streaming tool exchange.
 * The folded history itself remains the loaded-tool ledger, so undo,
 * compaction, and resume self-heal by re-folding. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';

import { DYNAMIC_TOOL_SCHEMA_VARIANT } from './dynamicTools';
import { IAgentToolSelectService } from './toolSelect';
import { IAgentToolSelectSchemasService } from './toolSelectSchemas';

export class AgentToolSelectSchemasService extends Disposable implements IAgentToolSelectSchemasService {
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
