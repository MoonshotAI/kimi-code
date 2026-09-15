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
