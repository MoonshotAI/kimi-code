import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionRunGate {
  readonly _serviceBrand: undefined;

  begin(): void;
  tryHold(): boolean;
}

export const ISessionRunGate: ServiceIdentifier<ISessionRunGate> =
  createDecorator<ISessionRunGate>('sessionRunGate');
