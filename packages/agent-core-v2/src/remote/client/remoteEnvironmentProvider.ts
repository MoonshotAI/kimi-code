import { randomUUID } from 'node:crypto';

import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IConfigService } from '#/app/config/config';
import { IEnvironmentDeclarationService } from '#/app/environmentDeclaration/environmentDeclaration';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
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
  EnvironmentProviderContext,
  EnvironmentProviderEnvironmentHandle,
  EnvironmentProviderFactory,
  EnvironmentProviderHost,
} from '#/environment/environmentProvider';

import { connectWithGuidance } from './connectGuidance';
import type { LocalRunner } from './executorDetect';
import type { LauncherSpec } from './launchers';
import { RemoteConnectionPool, type RemoteConnectionPoolHandle } from './remoteConnectionPool';
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

export class ManagedRemoteEnvironment implements Environment {
  readonly identity: EnvironmentIdentity;
  private inner: RemoteEnvironment | undefined;
  private readonly connectCallback: () => Promise<void>;
  private readonly ownsInner: boolean;
  private currentStatus: EnvironmentStatus;
  private readonly statusEmitter = new Emitter<EnvironmentStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;
  private statusSubscription?: { dispose(): void };
  private connectInflight?: Promise<void>;
  private lastConnectError?: string;

  constructor(
    inner: RemoteEnvironment | undefined,
    connectCallback: () => Promise<void>,
    identity: EnvironmentIdentity,
    options: { readonly ownsInner?: boolean } = {},
  ) {
    this.inner = inner;
    this.connectCallback = connectCallback;
    this.identity = identity;
    this.ownsInner = options.ownsInner === true;
    this.currentStatus = inner === undefined ? 'pending' : inner.status;
    this.bindInner(inner);
  }

  get capabilities(): ReadonlySet<EnvironmentCapability> {
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

  get fs(): IHostFileSystem | undefined {
    return this.inner?.fs;
  }

  get process() {
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

  adopt(inner: RemoteEnvironment): void {
    if (this.currentStatus === 'disposed') {
      void inner.dispose();
      return;
    }
    if (this.inner === inner) return;
    const previous = this.inner;
    this.bindInner(inner);
    this.inner = inner;
    this.lastConnectError = undefined;
    this.setStatus(inner.status);
    if (this.ownsInner && previous !== undefined) void previous.dispose();
  }

  connect(): Promise<void> {
    this.connectInflight ??= (async () => {
      this.lastConnectError = undefined;
      this.setStatus('connecting');
      try {
        await this.connectCallback();
        if (this.currentStatus === 'connecting') this.setStatus(this.inner?.status ?? 'pending');
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

  private bindInner(inner: RemoteEnvironment | undefined): void {
    this.statusSubscription?.dispose();
    this.statusSubscription = undefined;
    if (inner === undefined) return;
    this.statusSubscription = inner.onDidChangeStatus((status) => {
      if (this.inner !== inner) return;
      if (status === 'disconnected') {
        const closeReason = inner.connection.closeReason;
        if (closeReason !== undefined) this.lastConnectError = closeReason.reason;
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
    if (this.ownsInner) await inner?.dispose();
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
  handle: EnvironmentProviderEnvironmentHandle;
  view: ManagedRemoteEnvironment;
  declaration: RemoteEnvironmentDeclaration;
  fingerprint: string;
  detached: boolean;
  poolHandle?: RemoteConnectionPoolHandle;
  viewConnection?: RemoteEnvironment;
}

export class RemoteEnvironmentProviderFactory implements EnvironmentProviderFactory {
  readonly id = 'remote-exec';

  private readonly pool = new RemoteConnectionPool();

  constructor(private readonly options: RemoteEnvironmentProviderFactoryOptions = {}) {}

  async attach(context: EnvironmentProviderContext, host: EnvironmentProviderHost): Promise<EnvironmentProviderAttachment> {
    const log = host.get(ILogService);
    const config = host.get(IConfigService);
    const resolve = () =>
      resolveWorkspaceEnvironmentDeclarations(config);
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
      records.set(declaration.id, this.registerDeclaredEnvironment(context, host, declaration, log));
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

          record.detached = true;
          try {
            await record.handle.remove();
          } catch (error) {
            failures.push(error);
          } finally {
            releasePoolHandle(record);
          }
        }
        for (const declaration of resolved.entries) {
          if (disposed) throw new Error('remote environment provider is disposed');
          const fingerprint = declarationFingerprint(declaration.entry);
          const record = records.get(declaration.id);
          if (record === undefined) {
            try {
              records.set(declaration.id, this.registerDeclaredEnvironment(context, host, declaration, log));
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
          try {
            const next = this.createPendingEnvironment(context, record, log);
            await record.handle.update(() => next);
            record.view = next;
            record.fingerprint = fingerprint;
            releasePoolHandle(record);
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length > 0) throw new AggregateError(failures, 'remote environment declarations failed to reconcile');
      });
      return tail;
    };
    const reconciliation = host.get(IEnvironmentDeclarationService).registerReconciler(context.id, reconcile);
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
          record.detached = true;
          try {
            await record.handle.remove();
          } finally {
            releasePoolHandle(record);
          }
        }
        records.clear();
        await tail.catch(() => {});
      },
    };
  }

  private registerDeclaredEnvironment(
    context: EnvironmentProviderContext,
    host: EnvironmentProviderHost,
    declaration: RemoteEnvironmentDeclaration,
    log: ILogService,
  ): DeclaredEnvironmentRecord {
    const record: DeclaredEnvironmentRecord = {
      handle: undefined as unknown as EnvironmentProviderEnvironmentHandle,
      view: undefined as unknown as ManagedRemoteEnvironment,
      declaration,
      fingerprint: declarationFingerprint(declaration.entry),
      detached: false,
    };
    const view = this.createPendingEnvironment(context, record, log);
    record.view = view;
    record.handle = host.registerEnvironment(view);
    return record;
  }

  private createPendingEnvironment(context: EnvironmentProviderContext, record: DeclaredEnvironmentRecord, log: ILogService): ManagedRemoteEnvironment {
    const declaration = record.declaration;
    return new ManagedRemoteEnvironment(undefined, this.createConnectCallback(context, record, declaration, log), {
      workspaceId: context.id,
      environmentId: declaration.id,
      generation: `${declaration.id}-pending-${randomUUID()}`,
    });
  }

  private createConnectCallback(
    context: EnvironmentProviderContext,
    record: DeclaredEnvironmentRecord,
    declaration: RemoteEnvironmentDeclaration,
    log: ILogService,
  ): () => Promise<void> {
    const fingerprint = declarationFingerprint(declaration.entry);
    return async () => {
      const factory = async (): Promise<RemoteEnvironment> => {
        const connect = this.options.connect ?? ((opts: RemoteEnvironmentOptions) => RemoteEnvironment.connect(opts));
        const attempt = (launcher: LauncherSpec): Promise<RemoteEnvironment> =>
          connect({
            workspaceId: context.id,
            environmentId: declaration.id,
            launcher,
            clientVersion: this.options.clientVersion,
            minExecutorVersion: this.options.minExecutorVersion,
            initializeTimeoutMs: this.options.initializeTimeoutMs,
          });
        return connectWithGuidance(attempt, {
          launcher: toLauncherSpec(declaration.entry),
          minExecutorVersion: this.options.minExecutorVersion,
          runner: this.options.probeRunner,
        });
      };

      const pooled = record.poolHandle?.connection;
      if (pooled !== undefined) {
        if (pooled.status === 'ready' && record.viewConnection !== pooled) {
          this.swapPoolConnection(record, pooled);
          return;
        }
        const replaced = await this.pool.replace(fingerprint, factory);
        if (record.detached || declarationFingerprint(record.declaration.entry) !== fingerprint) return;
        this.swapPoolConnection(record, replaced);
        return;
      }
      const acquired = await this.pool.acquire(fingerprint, factory, {
        onPoolReplace: (connection) => {
          try {
            this.swapPoolConnection(record, connection);
          } catch (error: unknown) {
            log.warn(`remote environment ${declaration.id} pooled connection replacement failed`, { error });
          }
        },
      });
      if (record.detached || declarationFingerprint(record.declaration.entry) !== fingerprint) {
        acquired.release();
        return;
      }
      record.poolHandle = acquired;
      try {
        this.swapPoolConnection(record, acquired.connection);
      } catch (error) {
        record.poolHandle = undefined;
        record.viewConnection = undefined;
        acquired.release();
        throw error;
      }
    };
  }

  private swapPoolConnection(record: DeclaredEnvironmentRecord, connection: RemoteEnvironment): void {
    if (record.detached) return;
    const handle = record.poolHandle;
    if (handle?.connection !== connection || record.viewConnection === connection) return;
    if (handle.fingerprint !== declarationFingerprint(record.declaration.entry)) return;
    record.view.adopt(connection);
    record.viewConnection = connection;
  }
}

function releasePoolHandle(record: DeclaredEnvironmentRecord): void {
  const handle = record.poolHandle;
  record.poolHandle = undefined;
  record.viewConnection = undefined;
  handle?.release();
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
