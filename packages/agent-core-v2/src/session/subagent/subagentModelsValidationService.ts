import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IModelCatalog } from '#/kosong/model/catalog';

import { assertValidSubagentModelConfig } from './configSection';
import { ISessionSubagentModelsValidationService } from './subagentModelsValidation';

export class SessionSubagentModelsValidationService
  implements ISessionSubagentModelsValidationService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IConfigService config: IConfigService,
    @IFlagService flags: IFlagService,
    @IModelCatalog modelCatalog: IModelCatalog,
  ) {
    assertValidSubagentModelConfig(config, flags, modelCatalog);
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionSubagentModelsValidationService,
  SessionSubagentModelsValidationService,
  ScopeActivation.OnScopeCreated,
  'subagent',
);
