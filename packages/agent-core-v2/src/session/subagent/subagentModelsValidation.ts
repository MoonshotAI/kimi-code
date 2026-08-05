/**
 * `subagent` domain — `ISessionSubagentModelsValidationService` contract:
 * startup validation of the configured subagent model pool.
 *
 * The pool is primarily validated before session materialization by the
 * session lifecycle (see `workspace/sessionLifecycle`); this service repeats
 * the same check at Session-scope activation as a backstop, so a pool with a
 * missing/out-of-pool `default_model`, a reserved `primary` key, or an
 * unresolvable alias fails the session with `Error2(CONFIG_INVALID)` instead
 * of degrading into a mid-conversation tool failure handed back to the
 * parent model. Session-scoped — one instance per session; the contract
 * carries no methods because the validation is the construction side effect.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionSubagentModelsValidationService {
  readonly _serviceBrand: undefined;
}

export const ISessionSubagentModelsValidationService: ServiceIdentifier<ISessionSubagentModelsValidationService> =
  createDecorator<ISessionSubagentModelsValidationService>(
    'sessionSubagentModelsValidationService',
  );
