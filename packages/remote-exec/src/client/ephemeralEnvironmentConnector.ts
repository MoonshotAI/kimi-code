import { ScopeActivation, overrideScopedService } from '@moonshot-ai/agent-core-v2/_base/di/scope';
import { ILogService } from '@moonshot-ai/agent-core-v2/_base/log/log';
import { IOAuthService } from '@moonshot-ai/agent-core-v2/app/auth/auth';
import { IBootstrapService } from '@moonshot-ai/agent-core-v2/app/bootstrap/bootstrap';
import { LifecycleScope } from '@moonshot-ai/agent-core-v2/app/scopes';
import {
  IEphemeralEnvironmentConnector,
  type EphemeralEnvironmentConnectRequest,
  type EphemeralEnvironmentConnection,
} from '@moonshot-ai/agent-core-v2/environment/ephemeralEnvironment';
import { kimiRegionProfile } from '@moonshot-ai/kimi-code-oauth';

import { CdnExecutorArtifactLocator } from './artifactLocator';
import { connectWithAutoInstall } from './installTrigger';
import { RemoteEnvironment, type RemoteEnvironmentOptions } from './remoteEnvironment';
import { toLauncherSpec } from './remoteEnvironmentProvider';

export type EphemeralEnvironmentConnectFn = (
  options: RemoteEnvironmentOptions,
) => Promise<RemoteEnvironment>;

export class RemoteEphemeralEnvironmentConnector implements IEphemeralEnvironmentConnector {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IOAuthService private readonly oauth: IOAuthService,
    @ILogService private readonly log: ILogService,
    private readonly connectFn: EphemeralEnvironmentConnectFn = (options) =>
      RemoteEnvironment.connect(options),
  ) {}

  async connect(
    request: EphemeralEnvironmentConnectRequest,
  ): Promise<EphemeralEnvironmentConnection> {
    const launcher = toLauncherSpec(request.entry);
    const clientVersion = this.bootstrap.clientIdentity.version;
    const onDiagnostic = (line: string): void => {
      this.log.warn(line.trimEnd());
    };
    const connected = await connectWithAutoInstall(
      (spec) =>
        this.connectFn({
          workspaceId: request.workspaceId,
          environmentId: request.environmentId,
          launcher: spec,
          clientName: 'kimi-code',
          clientVersion,
          onDiagnostic,
        }),
      {
        launcher,
        artifactLocator: new CdnExecutorArtifactLocator({
          cdnBaseUrl: kimiRegionProfile(this.oauth.getRegion()).cdnBase,
        }),
        clientVersion,
        onDiagnostic,
      },
    );
    try {
      request.registry.register(connected);
    } catch (error) {
      await connected.dispose();
      throw error;
    }
    return { environment: connected, initialCwd: connected.host.cwd };
  }
}

overrideScopedService(
  LifecycleScope.App,
  IEphemeralEnvironmentConnector,
  RemoteEphemeralEnvironmentConnector,
  ScopeActivation.OnDemand,
  'remote-exec',
);
