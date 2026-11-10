import { Event } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

import { ISessionToolPolicyGate } from './sessionToolPolicyGate';

export class NoopSessionToolPolicyGate implements ISessionToolPolicyGate {
  declare readonly _serviceBrand: undefined;

  readonly disabledTools: readonly string[] = [];
  readonly onDidChange = Event.None as Event<void>;
}

registerScopedService(
  LifecycleScope.Session,
  ISessionToolPolicyGate,
  NoopSessionToolPolicyGate,
  ScopeActivation.OnScopeCreated,
  'sessionToolPolicyGate',
);
