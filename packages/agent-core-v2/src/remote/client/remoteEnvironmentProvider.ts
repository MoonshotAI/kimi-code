import { randomUUID } from 'node:crypto';

import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IEnvironmentDeclarationService } from '#/app/environmentDeclaration/environmentDeclaration';
import type {
  RemoteEnvironmentDeclaration,
  EnvironmentDeclarationSet,
} from '#/remote/declaration/remoteEnvironmentDeclaration';
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

import { EnvironmentError, type EnvironmentRegistrationHandle } from '#/environment/environmentRegistry';
import { POSIX_ENVIRONMENT_PATH, POSIX_ENVIRONMENT_WORKSPACE } from '#/environment/environmentDefaults';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import { classifyHandshakeFailure, connectWithGuidance } from './connectGuidance';
import { HandshakeError } from './connection';
import { declarationFingerprint, toLauncherSpec, type LauncherSpec } from './launchers';
import { RemoteSession, type RemoteSessionOptions } from './remoteSession';

const EMPTY_CAPABILITIES: ReadonlySet<EnvironmentCapability> = new Set();
const REMOTE_CAPABILITIES: ReadonlySet<EnvironmentCapability> = new Set(['fs', 'process']);

class DeclaredRemoteEnvironment implements Environment {
  private generation: string;

  get identity(): EnvironmentIdentity {
    return { environmentId: this.environmentId, generation: this.generation };
  }
  private session: RemoteSession | undefined;
  private launcher: LauncherSpec;
  private fingerprint: string;
  private currentStatus: EnvironmentStatus = 'pending';
  private inflight: Promise<void> | undefined;
  private lastConnectError: string | undefined;
  private epoch = 0;
  private readonly statusEmitter = new Emitter<EnvironmentStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;
  private hasConnected = false;
  private connectedAt = 0;
  readonly fs: IHostFileSystem = {
    _serviceBrand: undefined,
    readText: async (path, options) => this.connected().fs.readText(path, options),
    readWholeFile: async (path) => this.connected().fs.readWholeFile!(path),
    writeText: async (path, data) => this.connected().fs.writeText(path, data),
    writeTextWithParent: async (path, data, mode, parent) => this.connected().fs.writeTextWithParent!(path, data, mode, parent),
    appendText: async (path, data) => this.connected().fs.appendText(path, data),
    readBytes: async (path, n, offset) => this.connected().fs.readBytes(path, n, offset),
    writeBytes: async (path, data) => this.connected().fs.writeBytes(path, data),
    readLines: (path, options) => this.readLines(path, options),
    createExclusive: async (path, data) => this.connected().fs.createExclusive(path, data),
    stat: async (path) => this.connected().fs.stat(path),
    lstat: async (path) => this.connected().fs.lstat(path),
    readdir: async (path) => this.connected().fs.readdir(path),
    walk: async (path, options) => this.connected().fs.walk(path, options),
    mkdir: async (path, options) => this.connected().fs.mkdir(path, options),
    remove: async (path) => this.connected().fs.remove(path),
    rename: async (from, to) => this.connected().fs.rename(from, to),
    realpath: async (path) => this.connected().fs.realpath(path),
  };
  readonly process: IHostProcessService = {
    _serviceBrand: undefined,
    spawn: async (command, args, options) => this.connected().process.spawn(command, args, options),
  };

  constructor(
    private readonly environmentId: string,
    launcher: LauncherSpec,
    fingerprint: string,
    private readonly open: (launcher: LauncherSpec) => Promise<RemoteSession>,
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
    return this.session === undefined ? EMPTY_CAPABILITIES : REMOTE_CAPABILITIES;
  }

  get host(): Environment['host'] {
    return this.session?.host;
  }

  get path(): Environment['path'] {
    return this.session === undefined ? undefined : POSIX_ENVIRONMENT_PATH;
  }

  get workspace(): Environment['workspace'] {
    return this.session === undefined ? undefined : POSIX_ENVIRONMENT_WORKSPACE;
  }

  private connected(): RemoteSession {
    if (this.session !== undefined && this.currentStatus === 'ready') return this.session;
    throw new EnvironmentError('environment.unavailable', `environment ${this.environmentId} is ${this.currentStatus}`);
  }

  private async *readLines(path: string, options: Parameters<IHostFileSystem['readLines']>[1]): AsyncGenerator<string> {
    yield* this.connected().fs.readLines(path, options);
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

  private install(session: RemoteSession): void {
    const previous = this.session;
    this.generation = `${this.environmentId}-${randomUUID()}`;
    this.session = session;
    session.connection.onDidClose((info) => {
      if (this.session !== session) return;
      this.telemetry.track2('environment_disconnected', {
        environment_type: this.launcher.type,
        uptime_ms: performance.now() - this.connectedAt,
        reason: info.kind ?? 'other',
      });
      this.lastConnectError = info.reason;
      this.session = undefined;
      this.setStatus('disconnected');
      void session.dispose();
    });
    if (previous !== undefined && previous !== session) void previous.dispose();
  }

  private dropSession(): Promise<void> {
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
export interface SshPasswordOptions {
  readonly prompt: (environmentId: string) => Promise<string | undefined>;
  readonly askpassCommand: readonly [string, ...string[]];
}

export interface RemoteEnvironmentProviderFactoryOptions {
  readonly clientVersion?: string;
  readonly connect?: (options: RemoteSessionOptions) => Promise<RemoteSession>;
  readonly sshPassword?: SshPasswordOptions;
}

interface DeclaredEnvironmentRecord {
  handle: EnvironmentRegistrationHandle;
  environment: DeclaredRemoteEnvironment;
  declaration: RemoteEnvironmentDeclaration;
  fingerprint: string;
}

export class RemoteEnvironmentProviderFactory implements EnvironmentProviderFactory {
  readonly id = 'remote-exec';
  private readonly sshPasswords = new Map<string, { readonly launcher: LauncherSpec; readonly password: string }>();

  constructor(private readonly options: RemoteEnvironmentProviderFactoryOptions = {}) {}

  async attach(host: EnvironmentProviderHost): Promise<EnvironmentProviderAttachment> {
    const log = host.get(ILogService);
    const declarations = host.get(IEnvironmentDeclarationService);
    const initial = await declarations.declarations().catch((error: unknown) => {
      log.warn('remote environment declarations failed to load', { error });
      return undefined;
    });
    const records = new Map<string, DeclaredEnvironmentRecord>();
    for (const declaration of initial?.entries ?? []) {
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
          this.sshPasswords.delete(id);
          records.delete(id);
          declarations.reportRegistration(id);
          try {
            await record.handle.remove();
          } catch (error) {
            failures.push(error);
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
          this.sshPasswords.delete(declaration.id);
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
        await tail.catch(() => {});
        this.sshPasswords.clear();
        records.clear();
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
      return { handle, environment, declaration, fingerprint };
    } catch (error) {
      void environment.dispose();
      throw error;
    }
  }

  private open(environmentId: string, launcher: LauncherSpec): Promise<RemoteSession> {
    const connect = this.options.connect ?? ((options: RemoteSessionOptions) => RemoteSession.connect(options));
    const sshPassword = this.options.sshPassword;
    return connectWithGuidance(
      async (spec) => {
        const connectWithPassword = (password: string | undefined) => connect({
          environmentId,
          launcher: spec,
          clientVersion: this.options.clientVersion,
          sshAuth: password === undefined || sshPassword === undefined
            ? undefined
            : { password, command: sshPassword.askpassCommand },
        });
        const cached = this.sshPasswords.get(environmentId);
        try {
          return await connectWithPassword(cached?.launcher === launcher ? cached.password : undefined);
        } catch (error) {
          if (
            spec.type !== 'ssh' ||
            !(error instanceof HandshakeError) ||
            error.kind !== 'authentication' ||
            sshPassword === undefined
          ) {
            throw error;
          }
          this.sshPasswords.delete(environmentId);
          const password = await sshPassword.prompt(environmentId);
          if (password === undefined) throw error;
          this.sshPasswords.set(environmentId, { launcher, password });
          try {
            return await connectWithPassword(password);
          } catch (retryError) {
            if (retryError instanceof HandshakeError && retryError.kind === 'authentication') {
              this.sshPasswords.delete(environmentId);
            }
            throw retryError;
          }
        }
      },
      { launcher },
    );
  }
}
