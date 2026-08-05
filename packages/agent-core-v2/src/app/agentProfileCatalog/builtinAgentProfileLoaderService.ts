/**
 * `agentProfileCatalog` domain — `IBuiltinAgentProfileLoader` implementation.
 *
 * Snapshots the module-level contributions (`registerAgentProfile`, the
 * "import = register" pattern) on construction and registers them into
 * `IAgentProfileRegistry`. Register-after-construction is not supported: like
 * `IAgentToolRegistryService`, contributions are expected to accumulate at
 * import time before the container resolves the service. `getDefault()`
 * throws a `BugIndicatingError` when the builtin default profile is missing — a
 * programming-time invariant violation, not a request failure. Bound at App
 * scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { BugIndicatingError } from '#/errors';

import type { AgentProfile } from './agentProfileCatalog';
import { DEFAULT_AGENT_PROFILE_NAME } from './agentProfileCatalog';
import { AGENT_PROFILE_SOURCE_PRIORITY } from './agentProfileContribution';
import { IAgentProfileRegistry } from './agentProfileRegistry';
import {
  BUILTIN_AGENT_PROFILE_SOURCE_ID,
  IBuiltinAgentProfileLoader,
} from './builtinAgentProfileLoader';
import { getAgentProfileContributions } from './contribution';

export class BuiltinAgentProfileLoaderService
  extends Disposable
  implements IBuiltinAgentProfileLoader
{
  declare readonly _serviceBrand: undefined;

  private readonly byName: Map<string, AgentProfile>;
  private readonly ordered: readonly AgentProfile[];

  constructor(@IAgentProfileRegistry registry: IAgentProfileRegistry) {
    super();
    const contributions = getAgentProfileContributions();
    this.ordered = [...contributions];
    this.byName = new Map(this.ordered.map((def) => [def.name, def]));
    this._register(
      registry.register(
        BUILTIN_AGENT_PROFILE_SOURCE_ID,
        { profiles: this.ordered },
        { priority: AGENT_PROFILE_SOURCE_PRIORITY.builtin },
      ),
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

registerScopedService(
  LifecycleScope.App,
  IBuiltinAgentProfileLoader,
  BuiltinAgentProfileLoaderService,
  ScopeActivation.OnScopeCreated,
  'agentProfileCatalog',
);
