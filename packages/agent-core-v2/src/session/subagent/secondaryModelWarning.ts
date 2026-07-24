/**
 * `subagent` domain (L6) — `ISessionSecondaryModelWarningService` contract:
 * early validation of the configured secondary model.
 *
 * The secondary-model pointer (`[secondary_model]` / `KIMI_SECONDARY_MODEL`)
 * is otherwise validated lazily at spawn time, so a typo surfaces as a
 * mid-conversation tool failure handed back to the parent model. This service
 * front-loads the same resolution to session start (main-agent creation): an
 * unresolvable model or an effort the model does not list becomes a `warning`
 * event on the main agent's event bus, and stays cached for the edge to pull
 * (`GET /sessions/{id}/warnings`). Session-scoped — one instance per session.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const SECONDARY_MODEL_INVALID_WARNING_CODE = 'secondary-model-invalid';
export const SECONDARY_MODEL_EFFORT_WARNING_CODE = 'secondary-model-effort-not-listed';

export interface SecondaryModelWarning {
  readonly code: string;
  readonly message: string;
}

export interface ISessionSecondaryModelWarningService {
  readonly _serviceBrand: undefined;
  getSecondaryModelWarning(): SecondaryModelWarning | undefined;
}

export const ISessionSecondaryModelWarningService: ServiceIdentifier<ISessionSecondaryModelWarningService> =
  createDecorator<ISessionSecondaryModelWarningService>('sessionSecondaryModelWarningService');
