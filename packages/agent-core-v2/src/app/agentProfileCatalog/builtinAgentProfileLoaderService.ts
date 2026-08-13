/**
 * `agentProfileCatalog` domain — `IBuiltinAgentProfileLoader` implementation.
 *
 * Snapshots the module-level contributions (`registerAgentProfile`, the
 * "import = register" pattern) on construction and contributes them to the
 * `AgentProfileContribution` collection as the global `builtin` record.
 * Register-after-construction is not supported: like
 * `IAgentToolRegistryService`, contributions are expected to accumulate at
 * import time before the container resolves the service. `getDefault()`
 * throws a `BugIndicatingError` when the builtin default profile is missing — a
 * programming-time invariant violation, not a request failure. Bound at App
 * scope.
 */

import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { BugIndicatingError } from '#/errors';

import type { AgentProfile } from './agentProfileCatalog';
import { DEFAULT_AGENT_PROFILE_NAME } from './agentProfileCatalog';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  AgentProfileContribution,
  type AgentProfileContributionRecord,
} from './agentProfileContribution';
import {
  BUILTIN_AGENT_PROFILE_SOURCE_ID,
  IBuiltinAgentProfileLoader,
} from './builtinAgentProfileLoader';
import { getAgentProfileContributions } from './contribution';

// NOTE: stays Disposable — its own 'get' collides with the Fiber
export class BuiltinAgentProfileLoaderService
  extends Disposable
  implements IBuiltinAgentProfileLoader
{
  declare readonly _serviceBrand: undefined;

  private readonly byName: Map<string, AgentProfile>;
  private readonly ordered: readonly AgentProfile[];

  constructor(@IInstantiationService instantiationService: IInstantiationService) {
    super();
    const contributions = getAgentProfileContributions();
    this.ordered = [...contributions];
    this.byName = new Map(this.ordered.map((def) => [def.name, def]));
    this._register(
      instantiationService.createInstance(BuiltinAgentProfileContributionUnit, {
        sourceId: BUILTIN_AGENT_PROFILE_SOURCE_ID,
        priority: AGENT_PROFILE_SOURCE_PRIORITY.builtin,
        contribution: { profiles: this.ordered },
      }),
    );
  }

  get(name: string): AgentProfile | undefined {
    return this.byName.get(name);
  }

  getDefault(): AgentProfile {
    const profile = this.byName.get(DEFAULT_AGENT_PROFILE_NAME);
    if (profile === undefined) {
      throw new BugIndicatingError(
        `Default agent profile "${DEFAULT_AGENT_PROFILE_NAME}" is not registered`,
      );
    }
    return profile;
  }

  list(): readonly AgentProfile[] {
    return this.ordered;
  }
}

class BuiltinAgentProfileContributionUnit extends Service {
  constructor(record: AgentProfileContributionRecord) {
    super();
    this.provide(AgentProfileContribution, record);
  }
}

registerScopedService(
  LifecycleScope.App,
  IBuiltinAgentProfileLoader,
  BuiltinAgentProfileLoaderService,
  ScopeActivation.OnScopeCreated,
  'agentProfileCatalog',
);
