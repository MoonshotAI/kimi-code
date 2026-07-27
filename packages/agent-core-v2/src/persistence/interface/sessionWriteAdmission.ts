/**
 * `storage` domain (L1) — per-session physical-write admission contract.
 *
 * Defines the Session-scoped admission capability used to reject new writes
 * after sealing, track admitted physical I/O, and await its drain.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionWriteAdmission {
  readonly _serviceBrand: undefined;

  assertCanWriteNow(): void;
  withPhysicalWrite<T>(io: () => Promise<T>): Promise<T>;
  sealAndDrain(): Promise<void>;
}

export const ISessionWriteAdmission: ServiceIdentifier<ISessionWriteAdmission> =
  createDecorator<ISessionWriteAdmission>('sessionWriteAdmission');
