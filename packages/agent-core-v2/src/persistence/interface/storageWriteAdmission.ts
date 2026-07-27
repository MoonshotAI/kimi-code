/**
 * `storage` domain (L1) — App-scoped storage write-admission contract.
 *
 * Routes session-rooted storage scopes to their per-session admission while
 * leaving root and non-session scopes unrestricted. Missing session
 * registrations fail closed.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { ISessionWriteAdmission } from '#/persistence/interface/sessionWriteAdmission';

export interface IStorageWriteAdmission {
  readonly _serviceBrand: undefined;

  registerSession(sessionScope: string, admission: ISessionWriteAdmission): IDisposable;
  assertCanWriteNow(scope: string): void;
  withPhysicalWrite<T>(scope: string, io: () => Promise<T>): Promise<T>;
}

export const IStorageWriteAdmission: ServiceIdentifier<IStorageWriteAdmission> =
  createDecorator<IStorageWriteAdmission>('storageWriteAdmission');
