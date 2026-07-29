/**
 * `sessionToolPolicyGate` domain (L1) — seeded workspace tool-veto contract.
 *
 * Defines `ISessionToolPolicyGate`, the pure-data injection contract the
 * Workspace-scope `workspaceToolPolicy` hands to every Session scope it
 * creates: the workspace's os-level disabled-tool set as a live read view
 * plus its change event. The contract carries no IO — capability probing and
 * workspace config live on the workspace side; the Agent-scope `toolPolicy`
 * and `toolActivation` read this seed and apply the veto (it outranks every
 * Agent-side policy layer). Seeded into the Session scope by
 * `workspaceHandler` when the session is materialized; a no-op default
 * registration keeps scopes built without a handler (tests) resolvable.
 * Session-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { Event } from '#/_base/event';

export interface ISessionToolPolicyGate {
  readonly _serviceBrand: undefined;

  readonly disabledTools: readonly string[];
  readonly onDidChange: Event<void>;
}

export const ISessionToolPolicyGate: ServiceIdentifier<ISessionToolPolicyGate> =
  createDecorator<ISessionToolPolicyGate>('sessionToolPolicyGate');

export function sessionToolPolicyGateSeed(gate: ISessionToolPolicyGate): ScopeSeed {
  return [[ISessionToolPolicyGate as ServiceIdentifier<unknown>, gate]];
}
