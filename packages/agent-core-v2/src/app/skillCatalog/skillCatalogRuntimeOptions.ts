/**
 * `skillCatalog` domain (L3) — runtime options for skill discovery.
 *
 * Holds process-level runtime overrides that affect how skill roots are
 * resolved. `explicitDirs` mirrors v1's SDK `skillDirs`: when present, default
 * user / project discovery is skipped and the explicit directories are used as
 * the user source. Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

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

registerScopedService(
  LifecycleScope.App,
  ISkillCatalogRuntimeOptions,
  SkillCatalogRuntimeOptions,
  InstantiationType.Delayed,
  'skillCatalog',
);
