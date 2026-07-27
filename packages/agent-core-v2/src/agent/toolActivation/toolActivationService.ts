/**
 * `toolActivation` domain (L4) — `IAgentToolActivationService` implementation.
 *
 * Iterates the `toolRegistry` contribution table and, for each entry allowed
 * by the bound Profile's tool policy (`profile`), resolves the Agent-scope
 * service through the container — nothing constructs the tool before this
 * `accessor.get` — and registers the real instance into the runtime
 * registry.
 *
 * Activation runs once explicitly from `AgentLifecycleService.create` (after
 * restore and profile binding) and re-runs on every `agent.status.updated`
 * from `event`, so tools newly allowed by a runtime re-bind or
 * `setActiveTools` are activated without a restart. Already-registered names
 * are skipped, and nothing is ever unregistered here: restricting visibility
 * remains the request-time tool policy's job.
 *
 * Resolving contributions lazily inside `activate()` — never from the
 * constructor — keeps the historical cycle broken: some tools (SkillTool →
 * `prompt` → `loop` → `toolRegistry`) transitively depend on the tool
 * registry, which by activation time has long finished constructing. Bound
 * at Agent scope; the lifecycle's explicit `activate()` is the only
 * resolution path.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { IInstantiationService } from '#/_base/di/instantiation';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentProfileService } from '#/agent/profile/profile';
import { isToolActive } from '#/agent/toolPolicy/evaluate';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { getAgentToolContributions } from '#/agent/toolRegistry/toolContribution';

import { IAgentToolActivationService } from './toolActivation';

export class AgentToolActivationService extends Disposable implements IAgentToolActivationService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IInstantiationService private readonly instantiationService: IInstantiationService,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IEventBus eventBus: IEventBus,
  ) {
    super();
    this._register(
      eventBus.subscribe('agent.status.updated', () => {
        void this.activate();
      }),
    );
  }

  activate(): Promise<void> {
    const data = this.profile.data();
    const policy = { tools: data.activeToolNames, disallowedTools: data.disallowedTools };
    this.instantiationService.invokeFunction((accessor) => {
      for (const { id, options } of getAgentToolContributions()) {
        const source = options.source ?? 'builtin';
        if (this.toolRegistry.resolve(options.name) !== undefined) continue;
        if (!isToolActive(policy, options.name, source)) continue;
        if (options.when !== undefined && !options.when(accessor)) continue;
        const tool = accessor.get(id);
        this._register(
          this.toolRegistry.register(tool, {
            source: options.source,
            disclosure: options.disclosure,
          }),
        );
      }
    });
    return Promise.resolve();
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolActivationService,
  AgentToolActivationService,
  ScopeActivation.OnScopeCreated,
  'toolActivation',
);
