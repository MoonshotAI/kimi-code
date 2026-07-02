/**
 * `agentProfileCatalog` domain (L3) — `IAgentProfileCatalogService` impl.
 *
 * Snapshots the module-level contributions on construction. Register-after-
 * construction is not supported: like `IAgentToolRegistryService`, the
 * expectation is that contributions accumulate at import time before the
 * container resolves the service.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import type { AgentProfileDefinition } from './agentProfileCatalog';
import { IAgentProfileCatalogService } from './agentProfileCatalog';
import { getAgentProfileContributions } from './contribution';

export class AgentProfileCatalogService implements IAgentProfileCatalogService {
  declare readonly _serviceBrand: undefined;

  private readonly byName: Map<string, AgentProfileDefinition>;
  private readonly ordered: readonly AgentProfileDefinition[];

  constructor() {
    const contributions = getAgentProfileContributions();
    this.ordered = [...contributions];
    this.byName = new Map(this.ordered.map((def) => [def.name, def]));
  }

  get(name: string): AgentProfileDefinition | undefined {
    return this.byName.get(name);
  }

  list(): readonly AgentProfileDefinition[] {
    return this.ordered;
  }
}

registerScopedService(
  LifecycleScope.App,
  IAgentProfileCatalogService,
  AgentProfileCatalogService,
  InstantiationType.Delayed,
  'agentProfileCatalog',
);
