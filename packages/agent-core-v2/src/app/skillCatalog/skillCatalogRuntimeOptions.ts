/**
 * `skillCatalog` domain — runtime options for skill discovery.
 *
 * Holds process-level runtime overrides that affect how skill roots are
 * resolved. `explicitDirs` mirrors v1's SDK `skillDirs`: when present, default
 * user / project discovery is skipped and the explicit directories are used as
 * the user source. Bound at App scope.
 *
 * Composition roots set it through {@link skillCatalogRuntimeOptionsSeed}
 * — the registered default carries no explicit dirs.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import {
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
  type ScopeSeed,
} from '#/_base/di/scope';

export interface ISkillCatalogRuntimeOptions {
  readonly _serviceBrand: undefined;
  readonly explicitDirs?: readonly string[];
}

export const ISkillCatalogRuntimeOptions: ServiceIdentifier<ISkillCatalogRuntimeOptions> =
  createDecorator<ISkillCatalogRuntimeOptions>('skillCatalogRuntimeOptions');

export class SkillCatalogRuntimeOptions implements ISkillCatalogRuntimeOptions {
  declare readonly _serviceBrand: undefined;

  constructor(readonly explicitDirs?: readonly string[]) {}
}

export function skillCatalogRuntimeOptionsSeed(
  explicitDirs: readonly string[] | undefined,
): ScopeSeed {
  if (explicitDirs === undefined || explicitDirs.length === 0) return [];
  return [
    [
      ISkillCatalogRuntimeOptions as ServiceIdentifier<unknown>,
      new SkillCatalogRuntimeOptions(explicitDirs),
    ],
  ];
}

registerScopedService(
  LifecycleScope.App,
  ISkillCatalogRuntimeOptions,
  SkillCatalogRuntimeOptions,
  ScopeActivation.OnScopeCreated,
  'skillCatalog',
);
