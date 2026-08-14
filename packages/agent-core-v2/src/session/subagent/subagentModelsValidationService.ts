/**
 * `subagent` domain — `ISessionSubagentModelsValidationService` implementation.
 *
 * Backstop for the session lifecycle's pre-materialization check: validates
 * the configured subagent model section (`[secondary_model.models]` +
 * `[secondary_model].default_model`, plus the `force` rules) once per session
 * at scope construction (`ScopeActivation.OnScopeCreated`), so a broken pool
 * or forced model fails session creation with `Error2(CONFIG_INVALID)` even
 * on paths that bypass the lifecycle service. Reads the section through
 * `config` and resolves aliases through the model catalog — a lone
 * `default_model` included, as the implicit single-entry pool; a session
 * with neither pool nor force, or running with the `secondary-model`
 * experiment off, is a no-op. The checks themselves live in
 * `assertValidSubagentModelConfig` (configSection). Bound at Session scope.
 */

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
