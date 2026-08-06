/**
 * `features` domain — the `Feature` base class: one self-contained built-in
 * capability (plan, mcp, …) authored as a single App-scope unit recipe.
 *
 * A subclass declares its contributions inside its constructor through the
 * `contribute*` helpers — thin compositions over the unit capabilities and
 * the existing collection seams: config sections (`config`), per-scope
 * service materialization (`ScopeUnits` — the kernel folds one live unit per
 * present and future scope of that kind), agent tools (`toolRegistry`), and
 * agent profiles (`agentProfileCatalog`). Everything a Feature provides hangs
 * on its own book, so retracting the Feature unit withdraws every
 * contribution across the scope tree (连坐). Recipes declare a stable
 * `static readonly name`; the assembly keys managed units by it.
 */

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

export abstract class Feature extends Service {
  contribute<T>(token: CollectionToken<T>, value: T): FiberHandle {
    return this.provide(token, value);
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
