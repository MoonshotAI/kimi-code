/**
 * `subagent` domain — `ISessionSubagentModelsValidationService` implementation.
 *
 * Validates the configured subagent model pool (`[subagent.models]` +
 * `[subagent].default_model`) once per session at scope construction
 * (`ScopeActivation.OnScopeCreated`), so a broken pool fails session creation
 * with `Error2(CONFIG_INVALID)` — on the CLI that is a startup error; on
 * kap-server the session-create call returns the coded error. A session
 * without `[subagent.models]` is a no-op. The checks themselves live in
 * `assertValidSubagentModelPool` (configSection): default present, default in
 * the pool, every pool alias resolvable through the model catalog. Bound at
 * Session scope.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { IModelCatalog } from '#/kosong/model/catalog';

import {
  assertValidSubagentModelPool,
  resolveSubagentModelPool,
} from './configSection';
import { ISessionSubagentModelsValidationService } from './subagentModelsValidation';

export class SessionSubagentModelsValidationService
  implements ISessionSubagentModelsValidationService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IConfigService config: IConfigService,
    @IModelCatalog modelCatalog: IModelCatalog,
  ) {
    const pool = resolveSubagentModelPool(config);
    if (pool !== undefined) assertValidSubagentModelPool(pool, modelCatalog);
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionSubagentModelsValidationService,
  SessionSubagentModelsValidationService,
  ScopeActivation.OnScopeCreated,
  'subagent',
);
