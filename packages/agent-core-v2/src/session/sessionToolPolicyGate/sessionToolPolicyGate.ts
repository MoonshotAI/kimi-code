/**
 * `sessionToolPolicyGate` domain — seeded workspace tool-veto contract.
 *
 * Defines `ISessionToolPolicyGate`, the pure-data injection contract carrying
 * the workspace's os-level disabled-tool set as a live read view plus its
 * change event — a veto that outranks every Agent-side policy layer. The
 * contract carries no IO. Session-scoped.
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
