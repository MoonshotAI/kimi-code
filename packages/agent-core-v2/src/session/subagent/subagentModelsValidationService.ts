import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';

import { assertValidSubagentModelConfig } from './configSection';
import { ISessionSubagentModelsValidationService } from './subagentModelsValidation';
import { IProviderCatalogService } from '#/provider-catalog/providerCatalogService';

export class SessionSubagentModelsValidationService
  implements ISessionSubagentModelsValidationService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IConfigService config: IConfigService,
    @IProviderCatalogService modelCatalog: IProviderCatalogService,
  ) {
    assertValidSubagentModelConfig(config, modelCatalog);
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionSubagentModelsValidationService,
  SessionSubagentModelsValidationService,
  ScopeActivation.OnScopeCreated,
  'subagent',
);
