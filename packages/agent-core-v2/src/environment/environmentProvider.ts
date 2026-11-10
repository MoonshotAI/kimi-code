import type { ServiceIdentifier } from '#/_base/di/instantiation';
import type { Environment } from './environment';
import type { EnvironmentRegistrationHandle } from './environmentRegistry';

export interface EnvironmentProviderAttachment {
  dispose(): void | Promise<void>;
}

export interface EnvironmentProviderHost {
  get<T>(id: ServiceIdentifier<T>): T;
  registerEnvironment(environment: Environment): EnvironmentRegistrationHandle;
}

export interface EnvironmentProviderFactory {
  readonly id: string;
  attach(host: EnvironmentProviderHost): Promise<EnvironmentProviderAttachment>;
}
