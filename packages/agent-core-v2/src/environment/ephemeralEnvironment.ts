import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';

import type { Environment } from './environment';
import { EnvironmentError } from './environmentRegistry';
import type { IEnvironmentService } from '#/app/environment/environment';
import type { RemoteEnvironmentEntry } from './remoteEnvironmentDeclaration';

export interface EphemeralEnvironmentConnectRequest {
  readonly environmentId: string;
  readonly entry: RemoteEnvironmentEntry;
  readonly registry: Pick<IEnvironmentService, 'register'>;
}

export interface EphemeralEnvironmentConnection {
  readonly environment: Environment;
  readonly initialCwd?: string;
}

export interface IEphemeralEnvironmentConnector {
  readonly _serviceBrand: undefined;
  connect(request: EphemeralEnvironmentConnectRequest): Promise<EphemeralEnvironmentConnection>;
}

export const IEphemeralEnvironmentConnector: ServiceIdentifier<IEphemeralEnvironmentConnector> =
  createDecorator<IEphemeralEnvironmentConnector>('ephemeralEnvironmentConnector');

export const EPHEMERAL_ENVIRONMENT_CONNECTOR_UNAVAILABLE =
  'temporary environments are not available in this process (the remote-exec client is not loaded)';

export class UnavailableEphemeralEnvironmentConnector implements IEphemeralEnvironmentConnector {
  declare readonly _serviceBrand: undefined;

  connect(): Promise<EphemeralEnvironmentConnection> {
    throw new EnvironmentError(
      'environment.unavailable',
      EPHEMERAL_ENVIRONMENT_CONNECTOR_UNAVAILABLE,
    );
  }
}

registerScopedService(
  LifecycleScope.App,
  IEphemeralEnvironmentConnector,
  UnavailableEphemeralEnvironmentConnector,
  ScopeActivation.OnDemand,
  'ephemeralEnvironment',
);
