import { randomUUID } from 'node:crypto';

import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IEnvironmentDeclarationService } from '#/app/environmentDeclaration/environmentDeclaration';
import { declarationFingerprint, toLauncherSpec } from '#/environment/environmentDeclarations';
import type {
  RemoteEnvironmentDeclaration,
  EnvironmentDeclarationSet,
} from '#/environment/remoteEnvironmentDeclaration';
import type {
  Environment,
  EnvironmentCapability,
  EnvironmentIdentity,
  EnvironmentStatus,
} from '#/environment/environment';
import type {
  EnvironmentProviderAttachment,
  EnvironmentProviderFactory,
  EnvironmentProviderHost,
} from '#/environment/environmentProvider';

import type { EnvironmentRegistrationHandle } from '#/environment/environmentRegistry';
import { classifyHandshakeFailure, connectWithGuidance } from './connectGuidance';
import type { LauncherSpec } from './launchers';
import { RemoteEnvironment, type RemoteEnvironmentOptions } from './remoteEnvironment';

export { toLauncherSpec } from '#/environment/environmentDeclarations';

const EMPTY_CAPABILITIES: ReadonlySet<EnvironmentCapability> = new Set();

class DeclaredRemoteEnvironment implements Environment {
  private generation: string;

  get identity(): EnvironmentIdentity {
    return { environmentId: this.environmentId, generation: this.generation };
  }
  private session: RemoteEnvironment | undefined;
  private launcher: LauncherSpec;
  private fingerprint: string;
  private currentStatus: EnvironmentStatus = 'pending';
  private inflight: Promise<void> | undefined;
  private lastConnectError: string | undefined;
  private epoch = 0;
  private readonly statusEmitter = new Emitter<EnvironmentStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;
  private sessionSubscription: { dispose(): void } | undefined;
  private hasConnected = false;
  private connectedAt = 0;

  constructor(
    private readonly environmentId: string,
    launcher: LauncherSpec,
    fingerprint: string,
    private readonly open: (launcher: LauncherSpec) => Promise<RemoteEnvironment>,
    private readonly telemetry: ITelemetryService,
  ) {
    this.launcher = launcher;
    this.fingerprint = fingerprint;
    this.generation = `${environmentId}-${randomUUID()}`;
  }

  dispose(): Promise<void> {
    if (this.currentStatus === 'disposed') return Promise.resolve();
    this.epoch += 1;
    this.inflight = undefined;
    this.setStatus('disposed');
    this.statusEmitter.dispose();
    return this.dropSession();
  }

  get status(): EnvironmentStatus {
    return this.currentStatus;
  }

  get connectError(): string | undefined {
    return this.lastConnectError;
  }

  get whenReady(): Promise<void> | undefined {
    return this.inflight;
  }

  get capabilities(): ReadonlySet<EnvironmentCapability> {
    return this.session?.capabilities ?? EMPTY_CAPABILITIES;
  }

  get host(): Environment['host'] {
    return this.session?.host;
  }

  get path(): Environment['path'] {
    return this.session?.path;
  }

  get workspace(): Environment['workspace'] {
    return this.session?.workspace;
  }

  get fs(): Environment['fs'] {
    return this.session?.fs;
  }

  get process(): Environment['process'] {
    return this.session?.process;
  }

  connect(): Promise<void> {
    if (this.currentStatus === 'disposed') return Promise.reject(new Error('remote environment is disposed'));
    if (this.currentStatus === 'ready') return Promise.resolve();
    if (this.inflight !== undefined) return this.inflight;
    const epoch = this.epoch;
    const launcher = this.launcher;
    const started = performance.now();
    const isReconnect = this.hasConnected;
    this.lastConnectError = undefined;
    this.setStatus('connecting');
    const run = this.open(launcher).then((session) => {
      if (epoch !== this.epoch || this.currentStatus === 'disposed') {
        void session.dispose();
        throw new Error('remote environment connect was cancelled');
      }
      this.install(session);
      this.hasConnected = true;
      this.connectedAt = performance.now();
      this.setStatus('ready');
      this.telemetry.track2('environment_connected', {
        environment_type: launcher.type, duration_ms: performance.now() - started,
        outcome: 'ok', is_reconnect: isReconnect,
      });
    }).catch((error: unknown) => {
      this.telemetry.track2('environment_connected', {
        environment_type: launcher.type, duration_ms: performance.now() - started,
        outcome: epoch !== this.epoch ? 'cancelled' : 'error',
        error_type: epoch !== this.epoch ? undefined : classifyHandshakeFailure(error),
        is_reconnect: isReconnect,
      });
      if (epoch === this.epoch && this.currentStatus === 'connecting') {
        this.lastConnectError = error instanceof Error ? error.message : String(error);
        this.setStatus('disconnected');
      }
      throw error;
    }).finally(() => {
      if (this.inflight === run) this.inflight = undefined;
    });
    this.inflight = run;
    return run;
  }

  private disconnect(): void {
    if (this.currentStatus === 'disposed' || this.currentStatus === 'pending') return;
    this.epoch += 1;
    this.inflight = undefined;
    void this.dropSession();
    this.setStatus('disconnected');
  }

  applyLauncher(launcher: LauncherSpec, fingerprint: string): void {
    if (this.fingerprint === fingerprint) return;
    this.fingerprint = fingerprint;
    this.launcher = launcher;
    this.hasConnected = false;
    this.generation = `${this.environmentId}-${randomUUID()}`;
    if (this.currentStatus === 'pending') return;
    this.disconnect();
  }

  private install(session: RemoteEnvironment): void {
    const previous = this.session;
    this.generation = `${this.environmentId}-${randomUUID()}`;
    this.session = session;
    this.sessionSubscription?.dispose();
    this.sessionSubscription = session.onDidChangeStatus((status) => {
      if (this.session !== session || status !== 'disconnected') return;
      this.telemetry.track2('environment_disconnected', {
        environment_type: this.launcher.type,
        uptime_ms: performance.now() - this.connectedAt,
        reason: session.connection?.closeReason?.kind ?? 'other',
      });
      const reason = session.connection?.closeReason?.reason;
      if (reason !== undefined) this.lastConnectError = reason;
      this.session = undefined;
      this.sessionSubscription?.dispose();
      this.sessionSubscription = undefined;
      this.setStatus('disconnected');
      void session.dispose();
    });
    if (previous !== undefined && previous !== session) void previous.dispose();
  }

  private dropSession(): Promise<void> {
    this.sessionSubscription?.dispose();
    this.sessionSubscription = undefined;
    const session = this.session;
    this.session = undefined;
    return Promise.resolve(session?.dispose());
  }

  private setStatus(status: EnvironmentStatus): void {
    if (this.currentStatus === status || this.currentStatus === 'disposed') return;
    this.currentStatus = status;
    this.statusEmitter.fire(status);
  }
}
export interface RemoteEnvironmentProviderFactoryOptions {
  readonly clientVersion?: string;
  readonly connect?: (options: RemoteEnvironmentOptions) => Promise<RemoteEnvironment>;
}

interface DeclaredEnvironmentRecord {
  handle: EnvironmentRegistrationHandle;
  ownership: { dispose(): void };
  environment: DeclaredRemoteEnvironment;
  declaration: RemoteEnvironmentDeclaration;
  fingerprint: string;
}

export class RemoteEnvironmentProviderFactory implements EnvironmentProviderFactory {
  readonly id = 'remote-exec';

  constructor(private readonly options: RemoteEnvironmentProviderFactoryOptions = {}) {}

  async attach(host: EnvironmentProviderHost): Promise<EnvironmentProviderAttachment> {
    const log = host.get(ILogService);
    const declarations = host.get(IEnvironmentDeclarationService);
    let initial: EnvironmentDeclarationSet;
    try {
      initial = await declarations.catalog();
    } catch (error) {
      log.warn('remote environment declarations failed to load', { error });
      return {
        dispose() {},
      };
    }
    const records = new Map<string, DeclaredEnvironmentRecord>();
    for (const declaration of initial.entries) {
      try {
        records.set(declaration.id, this.registerDeclaredEnvironment(host, declaration));
        declarations.reportRegistration(declaration.id);
      } catch (error) {
        declarations.reportRegistration(declaration.id, error instanceof Error ? error : new Error(String(error)));
        log.warn('remote environment registration failed', { error });
      }
    }

    let disposed = false;
    let tail = Promise.resolve();
    const reconcile = (resolved: EnvironmentDeclarationSet): Promise<void> => {
      tail = tail.catch(() => {}).then(async () => {
        if (disposed) throw new Error('remote environment provider is disposed');
        const failures: unknown[] = [];
        const next = new Map(resolved.entries.map((declaration) => [declaration.id, declaration]));
        for (const [id, record] of records) {
          if (next.has(id)) continue;
          records.delete(id);
          declarations.reportRegistration(id);
          try {
            await record.handle.remove();
          } catch (error) {
            failures.push(error);
          } finally {
            record.ownership.dispose();
          }
        }
        for (const declaration of resolved.entries) {
          if (disposed) throw new Error('remote environment provider is disposed');
          const fingerprint = declarationFingerprint(declaration.entry);
          const record = records.get(declaration.id);
          if (record === undefined) {
            try {
              records.set(declaration.id, this.registerDeclaredEnvironment(host, declaration));
              declarations.reportRegistration(declaration.id);
            } catch (error) {
              declarations.reportRegistration(declaration.id, error instanceof Error ? error : new Error(String(error)));
              failures.push(error);
            }
            continue;
          }
          if (record.fingerprint === fingerprint) {
            record.declaration = declaration;
            continue;
          }
          record.declaration = declaration;
          record.fingerprint = fingerprint;
          record.environment.applyLauncher(toLauncherSpec(declaration.entry), fingerprint);
        }
        if (failures.length > 0) throw new AggregateError(failures, 'remote environment declarations failed to reconcile');
      });
      return tail;
    };
    const configListener = declarations.onDidChange((event) => {
      event.waitUntil(reconcile(event).catch((error: unknown) => { log.warn('remote environment declarations failed to reload', { error }); }));
    });
    return {
      dispose: async () => {
        disposed = true;
        configListener.dispose();
        for (const record of [...records.values()].toReversed()) {
          try {
            await record.handle.remove();
          } finally {
            record.ownership.dispose();
            records.delete(record.environment.identity.environmentId);
          }
        }
        await tail.catch(() => {});
      },
    };
  }

  private registerDeclaredEnvironment(
    host: EnvironmentProviderHost,
    declaration: RemoteEnvironmentDeclaration,
  ): DeclaredEnvironmentRecord {
    const launcher = toLauncherSpec(declaration.entry);
    const fingerprint = declarationFingerprint(declaration.entry);
    const environment = new DeclaredRemoteEnvironment(declaration.id, launcher, fingerprint, (nextLauncher) => this.open(declaration.id, nextLauncher), host.get(ITelemetryService));
    try {
      const handle = host.registerEnvironment(environment);
      const ownership = host.get(IEnvironmentDeclarationService).trackRegistration(environment);
      return { handle, ownership, environment, declaration, fingerprint };
    } catch (error) {
      void environment.dispose();
      throw error;
    }
  }

  private open(environmentId: string, launcher: LauncherSpec): Promise<RemoteEnvironment> {
    const connect = this.options.connect ?? ((options: RemoteEnvironmentOptions) => RemoteEnvironment.connect(options));
    return connectWithGuidance(
      (spec) => connect({
        environmentId,
        launcher: spec,
        clientVersion: this.options.clientVersion,
      }),
      { launcher },
    );
  }
}
