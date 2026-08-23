import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { StateRegistry } from '#/_base/state/stateRegistry';

import { ISessionStateService } from './sessionState';

export class SessionStateService extends StateRegistry implements ISessionStateService {
  declare readonly _serviceBrand: undefined;
  protected override readonly inspectScope = 'session';

  constructor() {
    super();
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionStateService,
  SessionStateService,
  ScopeActivation.OnScopeCreated,
  'state',
);
