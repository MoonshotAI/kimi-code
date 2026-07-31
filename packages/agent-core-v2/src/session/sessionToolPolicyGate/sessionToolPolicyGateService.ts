/**
 * `sessionToolPolicyGate` domain — no-op default `ISessionToolPolicyGate`.
 *
 * An empty gate (nothing vetoed, never changes) registered at Session scope
 * so Session/Agent scopes materialized WITHOUT a workspace handler — test
 * hosts, harness agents — still resolve the contract. The handler's seed
 * shadows this registration for real sessions, the same way every other
 * workspace-resource injection contract works.
 */

import { Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';

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
