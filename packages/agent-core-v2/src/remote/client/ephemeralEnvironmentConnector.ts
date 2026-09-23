import { randomUUID } from 'node:crypto';

import { ScopeActivation, overrideScopedService } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { LifecycleScope } from '#/app/scopes';
import type { Environment, EnvironmentCapability, EnvironmentIdentity, EnvironmentStatus } from '#/environment/environment';
import {
  IEphemeralEnvironmentConnector,
  type EphemeralEnvironmentConnectRequest,
  type EphemeralEnvironmentConnection,
} from '#/environment/ephemeralEnvironment';

import { connectWithGuidance } from './connectGuidance';
import { toLauncherSpec } from './remoteEnvironmentProvider';
import { RemoteEnvironment, type RemoteEnvironmentOptions } from './remoteEnvironment';

export type EphemeralEnvironmentConnectFn = (
  options: RemoteEnvironmentOptions,
) => Promise<RemoteEnvironment>;

const EMPTY_CAPABILITIES: ReadonlySet<EnvironmentCapability> = new Set();

class EphemeralRemoteEnvironment implements Environment {
  readonly identity: EnvironmentIdentity;
  private inner: RemoteEnvironment | undefined;
  private currentStatus: EnvironmentStatus;
  private readonly statusEmitter = new Emitter<EnvironmentStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;
  private statusSubscription: { dispose(): void } | undefined;
  private connectInflight: Promise<void> | undefined;
  private lastConnectError: string | undefined;

  constructor(
    inner: RemoteEnvironment,
    private readonly reconnectInner: () => Promise<RemoteEnvironment>,
    identity: EnvironmentIdentity,
  ) {
    this.identity = identity;
    this.inner = inner;
    this.currentStatus = inner.status;
    this.bindInner(inner);
  }

  get capabilities(): Environment['capabilities'] {
    return this.inner?.capabilities ?? EMPTY_CAPABILITIES;
  }

  get host(): Environment['host'] {
    return this.inner?.host;
  }

  get path(): Environment['path'] {
    return this.inner?.path;
  }

  get workspace(): Environment['workspace'] {
    return this.inner?.workspace;
  }

  get fs(): Environment['fs'] {
    return this.inner?.fs;
  }

  get process(): Environment['process'] {
    return this.inner?.process;
  }

  get status(): EnvironmentStatus {
    return this.currentStatus;
  }

  get whenReady(): Promise<void> | undefined {
    return this.connectInflight;
  }

  get connectError(): string | undefined {
    return this.lastConnectError;
  }

  connect(): Promise<void> {
    if (this.currentStatus === 'disposed') return Promise.reject(new Error('remote environment is disposed'));
    this.connectInflight ??= (async () => {
      this.lastConnectError = undefined;
      this.setStatus('connecting');
      try {
        const next = await this.reconnectInner();
        if (this.currentStatus === 'disposed') {
          await next.dispose();
          return;
        }
        const previous = this.inner;
        this.bindInner(next);
        this.inner = next;
        this.setStatus(next.status);
        if (previous !== undefined && previous !== next) void previous.dispose();
      } catch (error) {
        this.lastConnectError = error instanceof Error ? error.message : String(error);
        this.setStatus('disconnected');
        throw error;
      } finally {
        this.connectInflight = undefined;
      }
    })();
    return this.connectInflight;
  }

  private bindInner(inner: RemoteEnvironment): void {
    this.statusSubscription?.dispose();
    this.statusSubscription = inner.onDidChangeStatus((status) => {
      if (this.inner !== inner) return;
      if (status === 'disconnected') {
        const reason = (inner as { connection?: { closeReason?: { reason: string } } }).connection?.closeReason?.reason;
        if (reason !== undefined) this.lastConnectError = reason;
      }
      this.setStatus(status);
    });
  }

  private setStatus(status: EnvironmentStatus): void {
    if (this.currentStatus === status || this.currentStatus === 'disposed') return;
    this.currentStatus = status;
    this.statusEmitter.fire(status);
  }

  async dispose(): Promise<void> {
    this.statusSubscription?.dispose();
    this.statusSubscription = undefined;
    const inner = this.inner;
    this.inner = undefined;
    if (this.currentStatus !== 'disposed') {
      this.currentStatus = 'disposed';
      this.statusEmitter.fire('disposed');
    }
    this.statusEmitter.dispose();
    await inner?.dispose();
  }
}

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
    const connectInner = (): Promise<RemoteEnvironment> =>
      connectWithGuidance(
        (spec) =>
          this.connectFn({
            environmentId: request.environmentId,
            launcher: spec,
            clientVersion,
          }),
        { launcher },
      );
    const inner = await connectInner();
    const environment = new EphemeralRemoteEnvironment(inner, connectInner, {
      environmentId: request.environmentId,
      generation: `${request.environmentId}-${randomUUID()}`,
    });
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
