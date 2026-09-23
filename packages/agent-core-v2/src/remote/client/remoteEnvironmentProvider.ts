import { randomUUID } from 'node:crypto';

import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IConfigService } from '#/app/config/config';
import { IEnvironmentDeclarationService } from '#/app/environmentDeclaration/environmentDeclaration';
import { ENVIRONMENTS_SECTION } from '#/environment/configSection';
import { resolveWorkspaceEnvironmentDeclarations } from '#/environment/environmentDeclarations';
import type {
  RemoteEnvironmentDeclaration,
  RemoteEnvironmentEntry,
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
import { connectWithGuidance } from './connectGuidance';
import type { LocalRunner } from './executorDetect';
import type { LauncherSpec } from './launchers';
import { RemoteEnvironment, type RemoteEnvironmentOptions } from './remoteEnvironment';

export function toLauncherSpec(entry: RemoteEnvironmentEntry): LauncherSpec {
  if ('command' in entry) {
    return { type: 'command', program: entry.command, args: entry.args, env: entry.env };
  }
  switch (entry.type) {
    case 'ssh':
      return { type: 'ssh', host: entry.host, remoteBin: entry.remoteBin };
    case 'docker':
      return { type: 'docker', container: entry.container, context: entry.context, remoteBin: entry.remoteBin };
  }
}

const EMPTY_CAPABILITIES: ReadonlySet<EnvironmentCapability> = new Set();

function closeReasonOf(session: RemoteEnvironment): string | undefined {
  const connection = (session as { connection?: { closeReason?: { reason: string } } }).connection;
  return connection?.closeReason?.reason;
}

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

  constructor(
    private readonly environmentId: string,
    launcher: LauncherSpec,
    fingerprint: string,
    private readonly open: (launcher: LauncherSpec) => Promise<RemoteEnvironment>,
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
    this.lastConnectError = undefined;
    this.setStatus('connecting');
    const run = this.open(launcher).then((session) => {
      if (epoch !== this.epoch || this.currentStatus === 'disposed') {
        void session.dispose();
        throw new Error('remote environment connect was cancelled');
      }
      this.install(session);
      this.setStatus('ready');
    }).catch((error: unknown) => {
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

  disconnect(): void {
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
    this.generation = `${this.environmentId}-${randomUUID()}`;
    if (this.currentStatus === 'pending') return;
    this.disconnect();
  }

  private install(session: RemoteEnvironment): void {
    const previous = this.session;
    this.session = session;
    this.sessionSubscription?.dispose();
    this.sessionSubscription = session.onDidChangeStatus((status) => {
      if (this.session !== session || status !== 'disconnected') return;
      const reason = closeReasonOf(session);
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
  readonly minExecutorVersion?: string;
  readonly initializeTimeoutMs?: number;
  readonly connect?: (options: RemoteEnvironmentOptions) => Promise<RemoteEnvironment>;
  readonly probeRunner?: LocalRunner;
}

interface DeclaredEnvironmentRecord {
  handle: EnvironmentRegistrationHandle;
  environment: DeclaredRemoteEnvironment;
  declaration: RemoteEnvironmentDeclaration;
  fingerprint: string;
}

export class RemoteEnvironmentProviderFactory implements EnvironmentProviderFactory {
  readonly id = 'remote-exec';

  constructor(private readonly options: RemoteEnvironmentProviderFactoryOptions = {}) {}

  async attach(host: EnvironmentProviderHost): Promise<EnvironmentProviderAttachment> {
    const log = host.get(ILogService);
    const config = host.get(IConfigService);
    const resolve = () => resolveWorkspaceEnvironmentDeclarations(config);
    let initial: EnvironmentDeclarationSet;
    try {
      initial = await resolve();
    } catch (error) {
      log.warn('remote environment declarations failed to load', { error });
      return {
        dispose() {},
      };
    }
    const records = new Map<string, DeclaredEnvironmentRecord>();
    for (const declaration of initial.entries) {
      records.set(declaration.id, this.registerDeclaredEnvironment(host, declaration));
    }

    let disposed = false;
    let tail = Promise.resolve();
    const reconcile = (): Promise<void> => {
      tail = tail.catch(() => {}).then(async () => {
        if (disposed) throw new Error('remote environment provider is disposed');
        const resolved = await resolve();
        if (disposed) throw new Error('remote environment provider is disposed');
        const failures: unknown[] = [];
        const next = new Map(resolved.entries.map((declaration) => [declaration.id, declaration]));
        for (const [id, record] of records) {
          if (next.has(id)) continue;
          records.delete(id);
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
            } catch (error) {
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
    const reconciliation = host.get(IEnvironmentDeclarationService).registerReconciler(reconcile);
    const refresh = (): Promise<void> => reconcile().catch((error: unknown) => {
      log.warn('remote environment declarations failed to reload', { error });
    });
    const configListener = config.onDidSectionChange((event) => {
      if (event.domain === ENVIRONMENTS_SECTION) void refresh();
    });
    return {
      dispose: async () => {
        disposed = true;
        reconciliation.dispose();
        configListener.dispose();
        for (const record of [...records.values()].toReversed()) {
          try {
            await record.handle.remove();
          } finally {
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
    const fingerprint = declarationFingerprint(declaration.entry);
    const environment = new DeclaredRemoteEnvironment(declaration.id, toLauncherSpec(declaration.entry), fingerprint, (launcher) => this.open(declaration.id, launcher));
    try {
      return { handle: host.registerEnvironment(environment), environment, declaration, fingerprint };
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
        minExecutorVersion: this.options.minExecutorVersion,
        initializeTimeoutMs: this.options.initializeTimeoutMs,
      }),
      {
        launcher,
        minExecutorVersion: this.options.minExecutorVersion,
        runner: this.options.probeRunner,
      },
    );
  }
}

function declarationFingerprint(entry: RemoteEnvironmentEntry): string {
  return JSON.stringify(sortKeysDeep(entry));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, sortKeysDeep(nested)]),
    );
  }
  return value;
}
