import { IFeatureManager } from '#/app/feature/featureManager';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Service } from '#/_base/di/service';

import { IFeatureAssemblyService } from './featureAssembly';
import { getFeatureRecipes } from './featureRegistry';

export class FeatureAssemblyService extends Service implements IFeatureAssemblyService {
  declare readonly _serviceBrand: undefined;

  constructor(@IFeatureManager featureManager: IFeatureManager) {
    super();
    for (const recipe of getFeatureRecipes()) {
      featureManager.provideUnit(recipe);
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  IFeatureAssemblyService,
  FeatureAssemblyService,
  ScopeActivation.OnScopeCreated,
  'features',
);
