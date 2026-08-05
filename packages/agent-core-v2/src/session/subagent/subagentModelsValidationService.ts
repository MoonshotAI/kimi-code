/**
 * `subagent` domain — `ISessionSubagentModelsValidationService` implementation.
 *
 * Backstop for the session lifecycle's pre-materialization pool check:
 * validates the configured subagent model pool (`[subagent.models]` +
 * `[subagent].default_model`) once per session at scope construction
 * (`ScopeActivation.OnScopeCreated`), so a broken pool fails session creation
 * with `Error2(CONFIG_INVALID)` even on paths that bypass the lifecycle
 * service. Reads the pool through `config` and resolves aliases through the
 * model catalog. A session without `[subagent.models]` is a no-op. The checks
 * themselves live in `assertValidSubagentModelPool` (configSection): the
 * reserved `primary` key rejected, default present, default in the pool,
 * every pool alias resolvable. Bound at Session scope.
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
