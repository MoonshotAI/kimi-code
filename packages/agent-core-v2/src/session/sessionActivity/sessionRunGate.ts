import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';

export interface ISessionRunGate {
  readonly _serviceBrand: undefined;

  begin(): void;
  retain(): IDisposable;
}

export const ISessionRunGate: ServiceIdentifier<ISessionRunGate> =
  createDecorator<ISessionRunGate>('sessionRunGate');
