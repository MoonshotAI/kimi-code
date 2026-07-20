/**
 * `toolRegistry` domain (L3) — the Eager Agent-scope side-effect service that
 * consumes every module-level `registerTool(...)` contribution.
 *
 * Why this is separate from `AgentToolRegistryService`:
 *
 * Instantiating a tool pulls in that tool's `@IX` dependencies. Some tools
 * (SkillTool → IAgentPromptService → IAgentLoopService → IAgentToolRegistryService)
 * transitively depend on the tool registry itself. If contributions were consumed
 * inside `AgentToolRegistryService`'s constructor, the container would treat the
 * cascade as a recursive instantiation of the registry and throw
 * `illegal state - RECURSIVELY instantiating service 'agentToolRegistryService'`.
 *
 * Splitting the "iterate contributions and instantiate" step into its own
 * Eager service that injects the already-constructed registry breaks the cycle:
 * by the time we call `createInstance(SkillTool)`, `IAgentToolRegistryService`
 * has finished its own constructor and downstream `@IAgentToolRegistryService`
 * resolutions hit the cached instance instead of re-entering construction.
 *
 * `AgentLifecycleService.create` force-instantiates this service on Agent scope
 * creation so builtin tools land in the registry before the first turn.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import { IAgentToolRegistryService } from './toolRegistry';
import { getToolContributions } from './toolContribution';

export interface IAgentBuiltinToolsRegistrar {
  readonly _serviceBrand: undefined;
}

export const IAgentBuiltinToolsRegistrar: ServiceIdentifier<IAgentBuiltinToolsRegistrar> =
  createDecorator<IAgentBuiltinToolsRegistrar>('agentBuiltinToolsRegistrar');

export class AgentBuiltinToolsRegistrar extends Disposable implements IAgentBuiltinToolsRegistrar {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IInstantiationService instantiationService: IInstantiationService,
    @IAgentToolRegistryService toolRegistry: IAgentToolRegistryService,
  ) {
    super();
    instantiationService.invokeFunction((accessor) => {
      for (const contribution of getToolContributions()) {
        const { ctor, options } = contribution;
        if (options.when !== undefined && !options.when(accessor)) continue;
        const staticArgs = options.staticArgs?.(accessor) ?? [];
        const tool = instantiationService.createInstance(
          ctor,
          ...(staticArgs as []),
        );
        this._register(toolRegistry.register(tool, { source: options.source }));
      }
    });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentBuiltinToolsRegistrar,
  AgentBuiltinToolsRegistrar,
  InstantiationType.Eager,
  'toolRegistry',
);
