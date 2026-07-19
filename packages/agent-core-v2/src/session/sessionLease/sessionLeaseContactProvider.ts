/**
 * `sessionLease` domain (L6) — host-provided lease contact address.
 *
 * Holds what a session lease payload should advertise for this instance:
 * `{type: 'address', address}` when the host runs a routable network service
 * (kap-server seeds its listening address), `{type: 'local'}` otherwise —
 * the value is recorded in the lease payload so a blocked peer can tell a
 * routable holder from a local-only one (design:
 * `.tmp/refactor-watch-design-v2.md` §3.4.1 — the discriminated
 * `contact` union landing as the flat `address?` payload field). Read
 * lazily at every lease acquisition through the `contact` thunk, so a host
 * whose address is only known after listen can seed a provider that closes
 * over it. Composition roots override the local-only default through
 * {@link sessionLeaseContactSeed}; embedded engines pass nothing and keep
 * the default. Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService, type ScopeSeed } from '#/_base/di/scope';

export type SessionLeaseContact = { type: 'address'; address: string } | { type: 'local' };

export interface ISessionLeaseContactProvider {
  readonly _serviceBrand: undefined;

  readonly contact: () => SessionLeaseContact;
}

export const ISessionLeaseContactProvider: ServiceIdentifier<ISessionLeaseContactProvider> =
  createDecorator<ISessionLeaseContactProvider>('sessionLeaseContactProvider');

export class SessionLeaseContactProvider implements ISessionLeaseContactProvider {
  declare readonly _serviceBrand: undefined;

  constructor(readonly contact: () => SessionLeaseContact = () => ({ type: 'local' })) {}
}

export function sessionLeaseContactSeed(contact: () => SessionLeaseContact): ScopeSeed {
  return [
    [
      ISessionLeaseContactProvider as ServiceIdentifier<unknown>,
      new SessionLeaseContactProvider(contact),
    ],
  ];
}

registerScopedService(
  LifecycleScope.App,
  ISessionLeaseContactProvider,
  SessionLeaseContactProvider,
  InstantiationType.Eager,
  'sessionLease',
);
