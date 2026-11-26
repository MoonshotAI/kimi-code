import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';

export interface ISessionAdmission {
  readonly _serviceBrand: undefined;

  suspend(sessionIds: readonly string[], reason: string): IDisposable;
  assertAdmits(sessionId: string): void;
}

export const ISessionAdmission: ServiceIdentifier<ISessionAdmission> =
  createDecorator<ISessionAdmission>('sessionAdmission');
