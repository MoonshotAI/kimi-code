import { randomUUID } from 'node:crypto';

import { ScopeActivation, overrideScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { LifecycleScope } from '#/app/scopes';
import {
  IEphemeralEnvironmentConnector,
  type EphemeralEnvironmentConnectRequest,
  type EphemeralEnvironmentConnection,
} from '#/environment/ephemeralEnvironment';

import { connectWithGuidance } from './connectGuidance';
import { ManagedRemoteEnvironment, toLauncherSpec } from './remoteEnvironmentProvider';
import { RemoteEnvironment, type RemoteEnvironmentOptions } from './remoteEnvironment';

export type EphemeralEnvironmentConnectFn = (
  options: RemoteEnvironmentOptions,
) => Promise<RemoteEnvironment>;

export class RemoteEphemeralEnvironmentConnector implements IEphemeralEnvironmentConnector {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    private readonly connectFn: EphemeralEnvironmentConnectFn = (options) =>
      RemoteEnvironment.connect(options),
  ) {}

  async connect(
    request: EphemeralEnvironmentConnectRequest,
  ): Promise<EphemeralEnvironmentConnection> {
    const launcher = toLauncherSpec(request.entry);
    const clientVersion = this.bootstrap.clientIdentity.version;
    const connectInner = async (): Promise<RemoteEnvironment> =>
      connectWithGuidance(
        (spec) =>
          this.connectFn({
            workspaceId: request.workspaceId,
            environmentId: request.environmentId,
            launcher: spec,
            clientVersion,
          }),
        { launcher },
      );
    const inner = await connectInner();
    let environment!: ManagedRemoteEnvironment;
    environment = new ManagedRemoteEnvironment(
      inner,
      async () => {
        environment.adopt(await connectInner());
      },
      {
        workspaceId: request.workspaceId,
        environmentId: request.environmentId,
        generation: `${request.environmentId}-${randomUUID()}`,
      },
      { ownsInner: true },
    );
    try {
      request.registry.register(environment);
    } catch (error) {
      await environment.dispose();
      throw error;
    }
    return { environment, initialCwd: inner.host.cwd };
  }
}

overrideScopedService(
  LifecycleScope.App,
  IEphemeralEnvironmentConnector,
  RemoteEphemeralEnvironmentConnector,
  ScopeActivation.OnDemand,
  'remote-exec',
);
