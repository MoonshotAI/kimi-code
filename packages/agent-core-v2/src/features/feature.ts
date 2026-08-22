import { type CollectionToken } from '#/_base/di/collection';
import {
  ScopeUnits,
  type Fiber,
  type FiberHandle,
  type FiberProvideOptions,
  type ServiceClassRecipe,
} from '#/_base/di/fiber';
import { ScopeActivation, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import {
  AgentProfileContribution,
  AGENT_PROFILE_SOURCE_PRIORITY,
} from '#/app/agentProfileCatalog/agentProfileContribution';
import { FeatureServiceContribution } from '#/app/feature/featureServiceContribution';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { ConfigSchema, RegisterSectionOptions } from '#/app/config/config';
import { ConfigSectionContribution } from '#/app/config/configSectionContributions';
import { LifecycleScope } from '#/app/scopes';
import {
  CommandContribution,
  type CommandContribution as CommandContributionPayload,
} from '#/agent/command/commandContribution';
import {
  AgentToolContribution,
  type AgentToolContributionOptions,
  type AgentToolCtor,
  type AnyAgentTool,
} from '#/agent/toolRegistry/toolContribution';
import type {
  AgentEffectDefinition,
  SessionEffectDefinition,
} from '#/state/agentEffect';
import { AgentEffectContribution, SessionEffectContribution } from '#/state/agentEffect';
import type {
  AgentModel,
  AgentModelDefinition,
  SessionModelDefinition,
} from '#/state/agentModel';
import { AgentModelContribution, SessionModelContribution } from '#/state/agentModel';

export abstract class Feature extends Service {
  contribute<T>(token: CollectionToken<T>, value: T): FiberHandle {
    return this.provide(token, value);
  }

  contributeSessionModel<State>(definition: SessionModelDefinition<State>): FiberHandle {
    return this.provide(SessionModelContribution, definition as SessionModelDefinition);
  }

  contributeAgentModel<S, M extends AgentModel<S>>(
    definition: AgentModelDefinition<S, M>,
  ): FiberHandle {
    return this.provide(AgentModelContribution, definition as AgentModelDefinition<any, any>);
  }

  contributeSessionEffect(definition: SessionEffectDefinition): FiberHandle {
    return this.provide(SessionEffectContribution, definition);
  }

  contributeAgentEffect(definition: AgentEffectDefinition<any, any>): FiberHandle {
    return this.provide(AgentEffectContribution, definition);
  }

  contributeConfig<T>(
    domain: string,
    schema: ConfigSchema<T>,
    options: RegisterSectionOptions<T> = {},
  ): FiberHandle {
    return this.provide(ConfigSectionContribution, {
      domain,
      schema: schema as ConfigSchema<unknown>,
      options: options as RegisterSectionOptions<unknown>,
    });
  }

  contributeService<T>(
    scope: LifecycleScope,
    id: ServiceIdentifier<T>,
    ctor: ServiceClassRecipe,
    opts?: FiberProvideOptions,
  ): FiberHandle {
    this.provide(FeatureServiceContribution, { scope, id });
    return this.provide(ScopeUnits(scope), {
      name: `${this.name}:${String(id)}`,
      apply(fiber: Fiber): void {
        fiber.provide(id, ctor, opts);
      },
    });
  }

  contributeAgentService<T>(
    id: ServiceIdentifier<T>,
    ctor: ServiceClassRecipe,
    opts?: FiberProvideOptions,
  ): FiberHandle {
    return this.contributeService(LifecycleScope.Agent, id, ctor, opts);
  }

  contributeTool<T extends AnyAgentTool>(
    id: ServiceIdentifier<T>,
    ctor: AgentToolCtor<T>,
    options: AgentToolContributionOptions,
  ): void {
    this.contributeService(LifecycleScope.Agent, id, ctor, {
      activation: ScopeActivation.OnDemand,
    });
    this.provide(AgentToolContribution, { id, ctor, options });
  }

  contributeCommand(contribution: CommandContributionPayload): FiberHandle {
    return this.provide(CommandContribution, contribution);
  }

  contributeProfiles(
    profiles: readonly AgentProfile[],
    opts?: { readonly sourceId?: string; readonly priority?: number },
  ): FiberHandle {
    return this.provide(AgentProfileContribution, {
      sourceId: opts?.sourceId ?? `feature:${this.name}`,
      priority: opts?.priority ?? AGENT_PROFILE_SOURCE_PRIORITY.builtin,
      contribution: { profiles },
    });
  }

  onDispose(fn: () => void): void {
    this._register(toDisposable(fn));
  }
}
