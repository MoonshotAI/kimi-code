import type { ServiceClassRecipe } from '#/_base/di/fiber';
import { IConfigService } from '#/app/config/config';
import { IFeatureManager } from '#/app/feature/featureManager';
import { IFlagService } from '#/app/flag/flag';
import type { FlagId } from '#/app/flag/flagRegistry';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Service } from '#/_base/di/service';

import { IFeatureAssemblyService } from './featureAssembly';
import { getFeatureRegistrations } from './featureRegistry';

export class FeatureAssemblyService extends Service implements IFeatureAssemblyService {
  declare readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;

  constructor(
    @IFeatureManager featureManager: IFeatureManager,
    @IConfigService config: IConfigService,
    @IFlagService flags: IFlagService,
  ) {
    super();
    const gated: { recipe: ServiceClassRecipe; flag: FlagId }[] = [];
    for (const { recipe, flag } of getFeatureRegistrations()) {
      if (flag === undefined) {
        featureManager.provideUnit(recipe);
      } else {
        gated.push({ recipe, flag });
      }
    }
    this.ready = config.ready.then(() => {
      for (const { recipe, flag } of gated) {
        if (flags.enabled(flag)) {
          featureManager.provideUnit(recipe);
        }
      }
    });
    void this.ready.catch(() => {});
  }
}

registerScopedService(
  LifecycleScope.App,
  IFeatureAssemblyService,
  FeatureAssemblyService,
  ScopeActivation.OnScopeCreated,
  'features',
);
