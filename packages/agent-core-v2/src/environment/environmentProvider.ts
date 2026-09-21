import type { ServiceIdentifier } from '#/_base/di/instantiation';

import type { Environment } from './environment';

export interface EnvironmentProviderAttachment {
  dispose(): void | Promise<void>;
}

export interface EnvironmentProviderContext {
  readonly id: string;
  readonly root: string;
}

export interface EnvironmentProviderEnvironmentHandle {
  readonly environmentId: string;
  update(prepare: () => Environment | Promise<Environment>): Promise<void>;
  remove(): Promise<void>;
}

export interface EnvironmentProviderHost {
  get<T>(id: ServiceIdentifier<T>): T;
  registerEnvironment(environment: Environment): EnvironmentProviderEnvironmentHandle;
}

export interface EnvironmentProviderFactory {
  readonly id: string;
  attach(context: EnvironmentProviderContext, host: EnvironmentProviderHost): Promise<EnvironmentProviderAttachment>;
}
