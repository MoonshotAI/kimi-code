/**
 * `agentFileCatalog` domain (L3) — runtime options for agent-file discovery.
 *
 * Holds process-level runtime overrides: `explicitFiles` mirrors the CLI's
 * `--agent-file` — individual agent Markdown files loaded as the highest-
 * priority `explicit` source. Composition roots set it through
 * {@link agentCatalogRuntimeOptionsSeed}; the registered default carries no
 * explicit files. Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService, type ScopeSeed } from '#/_base/di/scope';

export interface IAgentCatalogRuntimeOptions {
  readonly _serviceBrand: undefined;
  readonly explicitFiles?: readonly string[];
}

export const IAgentCatalogRuntimeOptions: ServiceIdentifier<IAgentCatalogRuntimeOptions> =
  createDecorator<IAgentCatalogRuntimeOptions>('agentCatalogRuntimeOptions');

export class AgentCatalogRuntimeOptions implements IAgentCatalogRuntimeOptions {
  declare readonly _serviceBrand: undefined;

  constructor(readonly explicitFiles?: readonly string[]) {}
}

export function agentCatalogRuntimeOptionsSeed(
  explicitFiles: readonly string[] | undefined,
): ScopeSeed {
  if (explicitFiles === undefined || explicitFiles.length === 0) return [];
  return [
    [
      IAgentCatalogRuntimeOptions as ServiceIdentifier<unknown>,
      new AgentCatalogRuntimeOptions(explicitFiles),
    ],
  ];
}

registerScopedService(
  LifecycleScope.App,
  IAgentCatalogRuntimeOptions,
  AgentCatalogRuntimeOptions,
  InstantiationType.Eager,
  'agentFileCatalog',
);
