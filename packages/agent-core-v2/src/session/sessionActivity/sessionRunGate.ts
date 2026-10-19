import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionRunGate {
  readonly _serviceBrand: undefined;

  begin(): void;
}

export const ISessionRunGate: ServiceIdentifier<ISessionRunGate> =
  createDecorator<ISessionRunGate>('sessionRunGate');
