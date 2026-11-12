import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { SessionLockLease } from '#/persistence/interface/sessionLock';

export interface ISessionRunGate {
  readonly _serviceBrand: undefined;

  begin(): void;
  acquire(): SessionLockLease;
}

export const ISessionRunGate: ServiceIdentifier<ISessionRunGate> =
  createDecorator<ISessionRunGate>('sessionRunGate');
