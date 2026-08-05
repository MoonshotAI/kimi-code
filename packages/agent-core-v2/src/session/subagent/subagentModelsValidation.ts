/**
 * `subagent` domain — `ISessionSubagentModelsValidationService` contract:
 * startup validation of the configured subagent model pool.
 *
 * The `[subagent.models]` pool is otherwise validated lazily at spawn time, so
 * a typo surfaces as a mid-conversation tool failure handed back to the parent
 * model. This service front-loads the cross-field checks to session creation:
 * a pool with a missing/out-of-pool `default_model` or an unresolvable alias
 * fails the session with `Error2(CONFIG_INVALID)` instead of degrading
 * silently. Session-scoped — one instance per session; the contract carries no
 * methods because the validation is the construction side effect.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionSubagentModelsValidationService {
  readonly _serviceBrand: undefined;
}

export const ISessionSubagentModelsValidationService: ServiceIdentifier<ISessionSubagentModelsValidationService> =
  createDecorator<ISessionSubagentModelsValidationService>(
    'sessionSubagentModelsValidationService',
  );
