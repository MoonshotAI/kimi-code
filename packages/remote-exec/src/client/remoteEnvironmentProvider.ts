import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import * as posixPath from 'node:path/posix';

import { Emitter } from '@moonshot-ai/agent-core-v2/_base/event';
import { ILogService } from '@moonshot-ai/agent-core-v2/_base/log/log';
import { subtreeWatchFilter } from '@moonshot-ai/agent-core-v2/_base/utils/paths';
import { TimeoutTimer } from '@moonshot-ai/agent-core-v2/_base/utils/timer';
import { IConfigService } from '@moonshot-ai/agent-core-v2/app/config/config';
import { IEnvironmentDeclarationService } from '@moonshot-ai/agent-core-v2/app/environmentDeclaration/environmentDeclaration';
import { watch } from '@moonshot-ai/agent-core-v2/human/utils/watch';
import type { HostEnvironmentInfo } from '@moonshot-ai/agent-core-v2/os/interface/hostEnvironment';
import { IHostFileSystem } from '@moonshot-ai/agent-core-v2/os/interface/hostFileSystem';
import { IAtomicDocumentStore } from '@moonshot-ai/agent-core-v2/persistence/interface/atomicDocumentStore';
import { ENVIRONMENTS_SECTION } from '@moonshot-ai/agent-core-v2/environment/configSection';
import {
  PROJECT_ENVIRONMENTS_FILE,
  resolveWorkspaceEnvironmentDeclarations,
} from '@moonshot-ai/agent-core-v2/environment/environmentDeclarations';
import type {
  RemoteEnvironmentDeclaration,
  RemoteEnvironmentEntry,
  EnvironmentDeclarationSet,
} from '@moonshot-ai/agent-core-v2/environment/remoteEnvironmentDeclaration';
import type {
  Environment,
  EnvironmentCapability,
  EnvironmentIdentity,
  EnvironmentPath,
  EnvironmentStatus,
} from '@moonshot-ai/agent-core-v2/environment/environment';
import type {
  EnvironmentProviderAttachment,
  EnvironmentProviderContext,
  EnvironmentProviderFactory,
} from '@moonshot-ai/agent-core-v2/environment/environmentProvider';
import type {
  EnvironmentProviderHost,
  EnvironmentProviderEnvironmentHandle,
  EnvironmentUnitImports,
} from '@moonshot-ai/agent-core-v2/environment/environmentUnitHost';

import type { ExecutorArtifactLocator } from './artifactLocator';
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

const PENDING_ENVIRONMENT: HostEnvironmentInfo = {
  osKind: 'unknown',
  osArch: 'unknown',
  osVersion: '',
  shellName: 'sh',
  shellPath: '/bin/sh',
  pathClass: 'posix',
  homeDir: '/',
};

const PENDING_PATH: EnvironmentPath = {
  separator: '/',
  delimiter: ':',
  isAbsolute: (path) => posixPath.isAbsolute(path),
  join: (...paths) => posixPath.join(...paths),
  relative: (from, to) => posixPath.relative(from, to),
  resolve: (...paths) => posixPath.resolve(...paths),
  basename: (path) => posixPath.basename(path),
  dirname: (path) => posixPath.dirname(path),
};

export class ManagedRemoteEnvironment implements Environment {
  readonly identity: EnvironmentIdentity;
  readonly capabilities: ReadonlySet<EnvironmentCapability>;
  readonly host: HostEnvironmentInfo;
  readonly path: EnvironmentPath;
  readonly workspace: Environment['workspace'];
  private currentStatus: EnvironmentStatus;
  private readonly statusEmitter = new Emitter<EnvironmentStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;
  private readonly statusSubscription?: { dispose(): void };
  private connectInflight?: Promise<void>;
  private lastConnectError?: string;

  constructor(
    private readonly inner: RemoteEnvironment | undefined,
    private readonly connectCallback: () => Promise<void>,
    identity: EnvironmentIdentity,
  ) {
    this.identity = identity;
    if (inner === undefined) {
      this.capabilities = new Set();
      this.host = PENDING_ENVIRONMENT;
      this.path = PENDING_PATH;
      this.workspace = {
        mapRoots: (roots) => ({
          workDir: posixPath.resolve(roots.workDir),
          additionalDirs: roots.additionalDirs?.map((root) => posixPath.resolve(root)),
        }),
      };
      this.currentStatus = 'pending';
    } else {
      this.capabilities = inner.capabilities;
      this.host = inner.host;
      this.path = inner.path;
      this.workspace = inner.workspace;
      this.currentStatus = inner.status;
      this.statusSubscription = inner.onDidChangeStatus((status) => {
        if (status === 'disconnected') {
          const closeReason = inner.connection.closeReason;
          if (closeReason !== undefined) this.lastConnectError = closeReason.reason;
        }
        this.setStatus(status);
      });
    }
  }

  get fs() {
    return this.inner?.fs;
  }

  get process() {
    return this.inner?.process;
  }

  get terminal() {
    return this.inner?.terminal;
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
    this.connectInflight ??= (async () => {
      this.lastConnectError = undefined;
      this.setStatus('connecting');
      try {
        await this.connectCallback();
        // When this view's own connection was replaced, the inner's dispose
        // already settled the view through the status subscription. Syncing
        // with the inner covers a connect started by another view wrapping
        // the same live connection: this view stays usable. Pending views
        // have no inner and return to pending — no failure was observed.
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

  private setStatus(status: EnvironmentStatus): void {
    if (this.currentStatus === status || this.currentStatus === 'disposed') return;
    this.currentStatus = status;
    this.statusEmitter.fire(status);
  }

  // The executor connection is owned by the app-level connection pool, not by
  // this view: replacements (reconnect, declaration update) drain views
  // without tearing the connection down, and the pool disposes it once the
  // last workspace holder lets go.
  async dispose(): Promise<void> {
    this.statusSubscription?.dispose();
    if (this.currentStatus !== 'disposed') {
      this.currentStatus = 'disposed';
      this.statusEmitter.fire('disposed');
    }
    this.statusEmitter.dispose();
  }
}

export interface RemoteEnvironmentProviderFactoryOptions {
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly minExecutorVersion?: string;
  readonly initializeTimeoutMs?: number;
  readonly onDiagnostic?: (line: string) => void;
  readonly connect?: (options: RemoteEnvironmentOptions) => Promise<RemoteEnvironment>;
  // Executor detection (spec D8/D9): the locator resolves the release
  // artifact for the probed target so a missing/too-old executor's failure
  // guidance can name the concrete download (URL + pinned sha256); inject
  // `CdnExecutorArtifactLocator` built with the region CDN base
  // (`kimiRegionProfile(resolveKimiRegion(...)).cdnBase`) from the
  // composition root. Without a locator the guidance falls back to the
  // generic release-CDN wording.
  readonly artifactLocator?: ExecutorArtifactLocator;
  // Runner for the remote probes (docker tilde resolution, the guidance
  // platform probe). Injectable test seam.
  readonly probeRunner?: LocalRunner;
  // Project declaration watch (spec §4 hot reload): called once per attach
  // with the absolute path of `<root>/.kimi-code/environments.toml`; `onChange`
  // must fire when the file appears, changes, or disappears. Injectable for
  // tests; the default watches the workspace root one level deep, filtered
  // to the declaration file, debounced.
  readonly watchProjectDeclarations?: (path: string, onChange: () => void) => { dispose(): void };
}

interface DeclaredEnvironmentRecord {
  handle: EnvironmentProviderEnvironmentHandle;
  declaration: RemoteEnvironmentDeclaration;
  fingerprint: string;
  // Set when the record is torn down (declaration removed or attachment
  // disposed). An in-flight connect settling afterwards releases its pool
  // handle instead of swapping a view built from a stale declaration into the
  // registry; a declaration replace is caught by the fingerprint comparison.
  detached: boolean;
  // The lease on the pooled connection backing this record's live view,
  // owned by the app-level pool: managed views share it and never dispose it.
  // The record releases it on update and removal; the pool destroys the
  // connection once the last workspace holder lets go.
  poolHandle?: RemoteConnectionPoolHandle;
  // The pooled connection the record's live registry view wraps, undefined
  // while the view is a pending placeholder. The pool broadcasts every
  // replacement to all holders, so a mismatch against the handle's live
  // connection marks this view stale: it catches up to the pooled connection
  // instead of forcing another replacement.
  viewConnection?: RemoteEnvironment;
}

class EnvironmentSwapRedundantError extends Error {
  constructor() {
    super('view already wraps the pooled connection');
    this.name = 'EnvironmentSwapRedundantError';
  }
}

const PROJECT_DECLARATION_WATCH_DEBOUNCE_MS = 200;

export class RemoteEnvironmentProviderFactory implements EnvironmentProviderFactory {
  readonly id = 'remote-exec';
  readonly imports: EnvironmentUnitImports = {
    root: [IConfigService, IHostFileSystem, IAtomicDocumentStore, ILogService, IEnvironmentDeclarationService],
  };

  // App-level connection pool: one executor connection per declaration
  // fingerprint, shared by every workspace this factory attaches to. The pool
  // is only a cache — declaration resolution and trust checks stay per
  // workspace before any acquire.
  private readonly pool = new RemoteConnectionPool();

  constructor(private readonly options: RemoteEnvironmentProviderFactoryOptions = {}) {}

  async attach(context: EnvironmentProviderContext, host: EnvironmentProviderHost): Promise<EnvironmentProviderAttachment> {
    const log = host.get(ILogService);
    const config = host.get(IConfigService);
    const fs = host.get(IHostFileSystem);
    const docs = host.get(IAtomicDocumentStore);
    const resolve = () =>
      resolveWorkspaceEnvironmentDeclarations({ config, fs, docs, root: context.root });
    let initial: EnvironmentDeclarationSet;
    try {
      initial = await resolve();
      if (initial.projectError !== undefined) {
        log.warn('project remote environment declarations failed to load', { error: initial.projectError });
      }
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
        if (resolved.projectError !== undefined) {
          log.warn('project remote environment declarations failed to load', { error: resolved.projectError });
        }
        const next = new Map(resolved.entries.map((declaration) => [declaration.id, declaration]));
        for (const [id, record] of records) {
          if (next.has(id)) continue;
          records.delete(id);
          // Registry removal drains the generation: it leaves the registry at
          // once (new acquires fail `environment.not_found`), rejects new leases
          // as draining, and disposes the environment once held leases release
          // (bounded by the registry drain timeout). Bindings to the removed
          // environment keep failing explicitly — no silent local fallback (D3).
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
            await record.handle.update(() => this.createPendingEnvironment(context, record, log));
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
    const trustListener = context.onDidChangeTrust((change) => {
      change.waitUntil(refresh());
    });
    const watchProjectDeclarations = this.options.watchProjectDeclarations ?? watchProjectDeclarationFile;
    const projectWatch = watchProjectDeclarations(join(context.root, PROJECT_ENVIRONMENTS_FILE), () => {
      void refresh();
    });
    return {
      dispose: async () => {
        disposed = true;
        reconciliation.dispose();
        configListener.dispose();
        trustListener.dispose();
        projectWatch.dispose();
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
      declaration,
      fingerprint: declarationFingerprint(declaration.entry),
      detached: false,
    };
    record.handle = host.registerEnvironment(this.createPendingEnvironment(context, record, log));
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
    let inflight: Promise<void> | undefined;
    const fingerprint = declarationFingerprint(declaration.entry);
    const connectEnvironment = (): Promise<void> => {
      inflight ??= (async () => {
        try {
          const factory = async (): Promise<RemoteEnvironment> => {
            const connect = this.options.connect ?? ((opts: RemoteEnvironmentOptions) => RemoteEnvironment.connect(opts));
            const attempt = (launcher: LauncherSpec): Promise<RemoteEnvironment> =>
              connect({
                workspaceId: context.id,
                environmentId: declaration.id,
                launcher,
                clientName: this.options.clientName,
                clientVersion: this.options.clientVersion,
                minExecutorVersion: this.options.minExecutorVersion,
                initializeTimeoutMs: this.options.initializeTimeoutMs,
                onDiagnostic: this.options.onDiagnostic,
              });
            return connectWithGuidance(attempt, {
              launcher: toLauncherSpec(declaration.entry),
              artifactLocator: this.options.artifactLocator,
              clientVersion: this.options.clientVersion,
              minExecutorVersion: this.options.minExecutorVersion,
              runner: this.options.probeRunner,
            });
          };
          // A reconnect against a live pool lease: the pool invalidates the
          // shared connection, builds its replacement, and broadcasts the
          // swap to every workspace view on this fingerprint. A view the
          // broadcast has not reached yet (still draining its previous
          // generation) just catches up to the current pooled connection
          // instead of forcing yet another replacement. A handle whose entry
          // died reads back undefined — treat it as no handle and fall
          // through to the acquire path.
          const pooled = record.poolHandle?.connection;
          if (pooled !== undefined) {
            if (pooled.status === 'ready' && record.viewConnection !== pooled) {
              await this.swapPoolConnection(context, record, pooled, log);
              return;
            }
            const replaced = await this.pool.replace(fingerprint, factory);
            // Stale guards: the record was torn down, or its declaration
            // moved to a different fingerprint, while the replace was in
            // flight. The view swap must not happen; the pool handle is
            // owned (and released) by the reconcile path.
            if (record.detached || declarationFingerprint(record.declaration.entry) !== fingerprint) return;
            await this.swapPoolConnection(context, record, replaced, log);
            return;
          }
          const acquired = await this.pool.acquire(fingerprint, factory, {
            onPoolReplace: (connection) =>
              this.swapPoolConnection(context, record, connection, log).catch((error: unknown) => {
                log.warn(`remote environment ${declaration.id} pooled connection replacement failed`, { error });
              }),
          });
          // Stale guards: the record was torn down, or its declaration moved
          // to a different fingerprint, while the acquire was in flight. The
          // handle goes straight back; the view swap must not happen.
          if (record.detached || declarationFingerprint(record.declaration.entry) !== fingerprint) {
            acquired.release();
            return;
          }
          record.poolHandle = acquired;
          try {
            await record.handle.update(() => {
              const connection = acquired.connection;
              record.viewConnection = connection;
              return new ManagedRemoteEnvironment(connection, connectEnvironment, {
                workspaceId: context.id,
                environmentId: declaration.id,
                generation: connection.identity.generation,
              });
            });
          } catch (error) {
            record.poolHandle = undefined;
            record.viewConnection = undefined;
            acquired.release();
            throw error;
          }
        } finally {
          inflight = undefined;
        }
      })();
      return inflight;
    };
    return connectEnvironment;
  }

  // Swap the record's registry view onto the pool's current connection: the
  // broadcast side of a pool-level replace, and the catch-up for a view the
  // broadcast has not reached yet. Superseded broadcasts (the entry moved on
  // again, or the record's declaration changed fingerprint) and views already
  // wrapping the connection are no-ops.
  private async swapPoolConnection(
    context: EnvironmentProviderContext,
    record: DeclaredEnvironmentRecord,
    connection: RemoteEnvironment,
    log: ILogService,
  ): Promise<void> {
    if (record.detached) return;
    const handle = record.poolHandle;
    if (handle?.connection !== connection || record.viewConnection === connection) return;
    if (handle.fingerprint !== declarationFingerprint(record.declaration.entry)) return;
    const connectEnvironment = this.createConnectCallback(context, record, record.declaration, log);
    const previousView = record.viewConnection;
    try {
      await record.handle.update(() => {
        // A concurrent swap for the same connection (this record's own
        // reconnect racing the pool broadcast) already landed.
        if (record.viewConnection === connection) throw new EnvironmentSwapRedundantError();
        record.viewConnection = connection;
        return new ManagedRemoteEnvironment(connection, connectEnvironment, {
          workspaceId: context.id,
          environmentId: record.declaration.id,
          generation: connection.identity.generation,
        });
      });
    } catch (error) {
      if (error instanceof EnvironmentSwapRedundantError) return;
      record.viewConnection = previousView;
      throw error;
    }
  }
}

function releasePoolHandle(record: DeclaredEnvironmentRecord): void {
  const handle = record.poolHandle;
  record.poolHandle = undefined;
  record.viewConnection = undefined;
  handle?.release();
}

export function watchProjectDeclarationFile(path: string, onChange: () => void): { dispose(): void } {
  const debounce = new TimeoutTimer();
  const root = dirname(dirname(path));
  const handle = watch(root, { depth: 1, ignored: subtreeWatchFilter(root, [path]) });
  const subscription = handle.onDidChange(() => {
    debounce.cancelAndSet(onChange, PROJECT_DECLARATION_WATCH_DEBOUNCE_MS);
  });
  // The initial scan swallows events for files that appear before the watcher
  // is ready; one extra change notification on ready catches those edits.
  void handle.ready.then(() => {
    onChange();
  }, () => {});
  return {
    dispose: () => {
      debounce.dispose();
      subscription.dispose();
      handle.dispose();
    },
  };
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
