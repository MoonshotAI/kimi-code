import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import * as posixPath from 'node:path/posix';

import { Emitter } from '@moonshot-ai/agent-core-v2/_base/event';
import { ILogService } from '@moonshot-ai/agent-core-v2/_base/log/log';
import { subtreeWatchFilter } from '@moonshot-ai/agent-core-v2/_base/utils/paths';
import { TimeoutTimer } from '@moonshot-ai/agent-core-v2/_base/utils/timer';
import { IConfigService } from '@moonshot-ai/agent-core-v2/app/config/config';
import { IFlagService } from '@moonshot-ai/agent-core-v2/app/flag/flag';
import { watch } from '@moonshot-ai/agent-core-v2/human/utils/watch';
import type { HostEnvironmentInfo } from '@moonshot-ai/agent-core-v2/os/interface/hostEnvironment';
import { IHostFileSystem } from '@moonshot-ai/agent-core-v2/os/interface/hostFileSystem';
import { IAtomicDocumentStore } from '@moonshot-ai/agent-core-v2/persistence/interface/atomicDocumentStore';
import { RUNTIMES_SECTION } from '@moonshot-ai/agent-core-v2/runtime/configSection';
import { REMOTE_RUNTIME_FLAG_ID } from '@moonshot-ai/agent-core-v2/runtime/flag';
import {
  PROJECT_RUNTIMES_FILE,
  resolveWorkspaceRuntimeDeclarations,
} from '@moonshot-ai/agent-core-v2/runtime/runtimeDeclarations';
import type {
  RemoteRuntimeDeclaration,
  RemoteRuntimeEntry,
  RuntimeDeclarationSet,
} from '@moonshot-ai/agent-core-v2/runtime/remoteRuntimeDeclaration';
import type {
  Runtime,
  RuntimeCapability,
  RuntimeIdentity,
  RuntimePath,
  RuntimeStatus,
} from '@moonshot-ai/agent-core-v2/runtime/runtime';
import type {
  RuntimeProviderAttachment,
  RuntimeProviderContext,
  RuntimeProviderFactory,
} from '@moonshot-ai/agent-core-v2/runtime/runtimeProvider';
import type {
  RuntimeProviderHost,
  RuntimeProviderRuntimeHandle,
  RuntimeUnitImports,
} from '@moonshot-ai/agent-core-v2/runtime/runtimeUnitHost';

import type { ExecutorArtifactLocator } from './artifactLocator';
import type { LocalRunner } from './executorInstaller';
import { connectWithAutoInstall } from './installTrigger';
import type { LauncherSpec } from './launchers';
import { RemoteRuntime, type RemoteRuntimeOptions } from './remoteRuntime';

export function toLauncherSpec(entry: RemoteRuntimeEntry): LauncherSpec {
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

const PENDING_PATH: RuntimePath = {
  separator: '/',
  delimiter: ':',
  isAbsolute: (path) => posixPath.isAbsolute(path),
  join: (...paths) => posixPath.join(...paths),
  relative: (from, to) => posixPath.relative(from, to),
  resolve: (...paths) => posixPath.resolve(...paths),
  basename: (path) => posixPath.basename(path),
  dirname: (path) => posixPath.dirname(path),
};

export class ManagedRemoteRuntime implements Runtime {
  readonly identity: RuntimeIdentity;
  readonly capabilities: ReadonlySet<RuntimeCapability>;
  readonly environment: HostEnvironmentInfo;
  readonly path: RuntimePath;
  readonly workspace: Runtime['workspace'];
  private currentStatus: RuntimeStatus;
  private readonly statusEmitter = new Emitter<RuntimeStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;
  private readonly statusSubscription?: { dispose(): void };
  private connectInflight?: Promise<void>;
  private lastConnectError?: string;

  constructor(
    private readonly inner: RemoteRuntime | undefined,
    private readonly connectCallback: () => Promise<void>,
    private readonly rerootCallback: (cwd: string) => Promise<void>,
    identity: RuntimeIdentity,
  ) {
    this.identity = identity;
    if (inner === undefined) {
      this.capabilities = new Set();
      this.environment = PENDING_ENVIRONMENT;
      this.path = PENDING_PATH;
      this.workspace = {
        mapRoots: (roots) => ({
          workDir: posixPath.resolve(roots.workDir),
          additionalDirs: roots.additionalDirs?.map((root) => posixPath.resolve(root)),
        }),
      };
      this.currentStatus = 'disconnected';
    } else {
      this.capabilities = inner.capabilities;
      this.environment = inner.environment;
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

  get status(): RuntimeStatus {
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
        // have no inner and end disconnected, as before.
        if (this.currentStatus === 'connecting') this.setStatus(this.inner?.status ?? 'disconnected');
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

  reroot(cwd: string): Promise<void> {
    return this.rerootCallback(cwd);
  }

  private setStatus(status: RuntimeStatus): void {
    if (this.currentStatus === status || this.currentStatus === 'disposed') return;
    this.currentStatus = status;
    this.statusEmitter.fire(status);
  }

  // The executor connection is owned by the declaring record, not by this
  // view: replacements (reconnect, reroot, declaration update) drain views
  // without tearing the connection down, and the record disposes it.
  async dispose(): Promise<void> {
    this.statusSubscription?.dispose();
    if (this.currentStatus !== 'disposed') {
      this.currentStatus = 'disposed';
      this.statusEmitter.fire('disposed');
    }
    this.statusEmitter.dispose();
  }
}

export interface RemoteRuntimeProviderFactoryOptions {
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly minExecutorVersion?: string;
  readonly initializeTimeoutMs?: number;
  readonly onDiagnostic?: (line: string) => void;
  readonly connect?: (options: RemoteRuntimeOptions) => Promise<RemoteRuntime>;
  // Executor auto-install (spec D8): the locator resolves the SEA artifact for
  // the probed target; inject `CdnExecutorArtifactLocator` built with the
  // region CDN base (`kimiRegionProfile(resolveKimiRegion(...)).cdnBase`) from
  // the composition root. Without a locator, missing executors get manual
  // install guidance instead of an auto-install attempt.
  readonly artifactLocator?: ExecutorArtifactLocator;
  readonly autoInstall?: boolean;
  readonly installRunner?: LocalRunner;
  readonly installFetch?: typeof fetch;
  // Project declaration watch (spec §4 hot reload): called once per attach
  // with the absolute path of `<root>/.kimi-code/runtimes.toml`; `onChange`
  // must fire when the file appears, changes, or disappears. Injectable for
  // tests; the default watches the workspace root one level deep, filtered
  // to the declaration file, debounced.
  readonly watchProjectDeclarations?: (path: string, onChange: () => void) => { dispose(): void };
}

interface DeclaredRuntimeRecord {
  handle: RuntimeProviderRuntimeHandle;
  declaration: RemoteRuntimeDeclaration;
  fingerprint: string;
  // Bumped whenever the declaration is replaced or the record is torn down.
  // An in-flight connect started under an older version disposes its result
  // instead of swapping a runtime built from a stale declaration into the
  // registry.
  version: number;
  // The live executor connection, owned by the record: managed views share it
  // and never dispose it, so a reroot replacement keeps serving the same
  // connection. The record disposes it on reconnect, update, and removal.
  connection?: RemoteRuntime;
  // The latest reroot cwd; carried into the identity of every connected view.
  boundCwd?: string;
  // The most recent view's connect callback, reused by reroot replacements.
  connect?: () => Promise<void>;
}

const PROJECT_DECLARATION_WATCH_DEBOUNCE_MS = 200;

export class RemoteRuntimeProviderFactory implements RuntimeProviderFactory {
  readonly id = 'remote-exec';
  readonly imports: RuntimeUnitImports = {
    root: [IFlagService, IConfigService, IHostFileSystem, IAtomicDocumentStore, ILogService],
    imports: [],
    local: [],
  };

  constructor(private readonly options: RemoteRuntimeProviderFactoryOptions = {}) {}

  async attach(context: RuntimeProviderContext, host: RuntimeProviderHost): Promise<RuntimeProviderAttachment> {
    if (!host.get(IFlagService).enabled(REMOTE_RUNTIME_FLAG_ID)) {
      return {
        dispose() {},
      };
    }
    const log = host.get(ILogService);
    const config = host.get(IConfigService);
    const fs = host.get(IHostFileSystem);
    const docs = host.get(IAtomicDocumentStore);
    const resolve = () =>
      resolveWorkspaceRuntimeDeclarations({ config, fs, docs, root: context.root });
    let initial: RuntimeDeclarationSet;
    try {
      initial = await resolve();
      if (initial.projectError !== undefined) {
        log.warn('project remote runtime declarations failed to load', { error: initial.projectError });
      }
    } catch (error) {
      log.warn('remote runtime declarations failed to load', { error });
      return {
        dispose() {},
      };
    }
    const records = new Map<string, DeclaredRuntimeRecord>();
    for (const declaration of initial.entries) {
      records.set(declaration.id, this.registerDeclaredRuntime(context, host, declaration));
    }

    // Live declaration watch: user-level changes arrive through the config
    // service's section event; project-level changes through a file watch on
    // `.kimi-code/runtimes.toml`. Each trigger re-resolves declarations —
    // trust is re-read on every resolve, so trust flips re-gate project
    // declarations at the next trigger — and diffs them against the
    // registered records. Reconciles are serialized on `tail`.
    let disposed = false;
    let tail = Promise.resolve();
    const reconcile = (): void => {
      tail = tail.catch(() => {}).then(async () => {
        if (disposed) return;
        let resolved: RuntimeDeclarationSet;
        try {
          resolved = await resolve();
        } catch (error) {
          log.warn('remote runtime declarations failed to reload', { error });
          return;
        }
        if (resolved.projectError !== undefined) {
          log.warn('project remote runtime declarations failed to load', { error: resolved.projectError });
        }
        if (disposed) return;
        const next = new Map(resolved.entries.map((declaration) => [declaration.id, declaration]));
        for (const [id, record] of records) {
          if (next.has(id)) continue;
          records.delete(id);
          // Registry removal drains the generation: it leaves the registry at
          // once (new acquires fail `runtime.not_found`), rejects new leases
          // as draining, and disposes the runtime once held leases release
          // (bounded by the registry drain timeout). Bindings to the removed
          // runtime keep failing explicitly — no silent local fallback (D3).
          record.version += 1;
          void record.handle.remove()
            .then(() => discardConnection(record))
            .catch((error: unknown) => {
              log.warn(`remote runtime ${id} removal failed`, { error });
            });
        }
        for (const declaration of resolved.entries) {
          if (disposed) return;
          const fingerprint = declarationFingerprint(declaration.entry);
          const record = records.get(declaration.id);
          if (record === undefined) {
            try {
              records.set(declaration.id, this.registerDeclaredRuntime(context, host, declaration));
            } catch (error) {
              // A failed entry keeps no record, so the next trigger retries it.
              log.warn(`remote runtime ${declaration.id} registration failed`, { error });
            }
            continue;
          }
          if (record.fingerprint === fingerprint) continue;
          record.version += 1;
          record.declaration = declaration;
          try {
            await record.handle.update(() => this.createPendingRuntime(context, record));
            record.fingerprint = fingerprint;
            await discardConnection(record);
          } catch (error) {
            log.warn(`remote runtime ${declaration.id} update failed`, { error });
          }
        }
      });
    };
    const configListener = config.onDidSectionChange((event) => {
      if (event.domain === RUNTIMES_SECTION) reconcile();
    });
    const watchProjectDeclarations = this.options.watchProjectDeclarations ?? watchProjectDeclarationFile;
    const projectWatch = watchProjectDeclarations(join(context.root, PROJECT_RUNTIMES_FILE), reconcile);
    return {
      dispose: async () => {
        disposed = true;
        configListener.dispose();
        projectWatch.dispose();
        for (const record of [...records.values()].toReversed()) {
          record.version += 1;
          try {
            await record.handle.remove();
          } finally {
            await discardConnection(record);
          }
        }
        records.clear();
        await tail.catch(() => {});
      },
    };
  }

  private registerDeclaredRuntime(
    context: RuntimeProviderContext,
    host: RuntimeProviderHost,
    declaration: RemoteRuntimeDeclaration,
  ): DeclaredRuntimeRecord {
    const record: DeclaredRuntimeRecord = {
      handle: undefined as unknown as RuntimeProviderRuntimeHandle,
      declaration,
      fingerprint: declarationFingerprint(declaration.entry),
      version: 0,
    };
    record.handle = host.registerRuntime(this.createPendingRuntime(context, record));
    return record;
  }

  private createPendingRuntime(context: RuntimeProviderContext, record: DeclaredRuntimeRecord): ManagedRemoteRuntime {
    let inflight: Promise<void> | undefined;
    const version = record.version;
    const declaration = record.declaration;
    const reroot = (cwd: string): Promise<void> => this.rerootRecord(context, record, cwd);
    const connectRuntime = (): Promise<void> => {
      inflight ??= (async () => {
        try {
          const connect = this.options.connect ?? ((opts: RemoteRuntimeOptions) => RemoteRuntime.connect(opts));
          const attempt = (launcher: LauncherSpec): Promise<RemoteRuntime> =>
            connect({
              workspaceId: context.id,
              runtimeId: declaration.id,
              launcher,
              clientName: this.options.clientName,
              clientVersion: this.options.clientVersion,
              minExecutorVersion: this.options.minExecutorVersion,
              initializeTimeoutMs: this.options.initializeTimeoutMs,
              onDiagnostic: this.options.onDiagnostic,
            });
          const connected = await connectWithAutoInstall(attempt, {
            launcher: toLauncherSpec(declaration.entry),
            artifactLocator: this.options.artifactLocator,
            autoInstall: this.options.autoInstall,
            clientVersion: this.options.clientVersion,
            minExecutorVersion: this.options.minExecutorVersion,
            runner: this.options.installRunner,
            fetchImpl: this.options.installFetch,
            onDiagnostic: this.options.onDiagnostic,
          });
          if (record.version !== version) {
            await connected.dispose();
            return;
          }
          const previous = record.connection;
          record.connection = connected;
          try {
            await record.handle.update(() => new ManagedRemoteRuntime(connected, connectRuntime, reroot, {
              workspaceId: context.id,
              runtimeId: declaration.id,
              generation: connected.identity.generation,
              cwd: record.boundCwd,
            }));
          } catch (error) {
            record.connection = previous;
            await connected.dispose();
            throw error;
          }
          await previous?.dispose();
        } finally {
          inflight = undefined;
        }
      })();
      return inflight;
    };
    record.connect = connectRuntime;
    return new ManagedRemoteRuntime(undefined, connectRuntime, reroot, {
      workspaceId: context.id,
      runtimeId: declaration.id,
      generation: `${declaration.id}-pending-${randomUUID()}`,
    });
  }

  private async rerootRecord(context: RuntimeProviderContext, record: DeclaredRuntimeRecord, cwd: string): Promise<void> {
    const connection = record.connection;
    if (connection === undefined) {
      // Pending or disconnected: the next connected view carries the cwd.
      record.boundCwd = cwd;
      return;
    }
    const connect = record.connect;
    if (connect === undefined) throw new Error(`remote runtime ${record.declaration.id} has no connect callback`);
    await record.handle.update(() => new ManagedRemoteRuntime(connection, connect, (next) => this.rerootRecord(context, record, next), {
      workspaceId: context.id,
      runtimeId: record.declaration.id,
      generation: `${record.declaration.id}-root-${randomUUID()}`,
      cwd,
    }));
    record.boundCwd = cwd;
  }
}

async function discardConnection(record: DeclaredRuntimeRecord): Promise<void> {
  const connection = record.connection;
  record.connection = undefined;
  await connection?.dispose();
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

function declarationFingerprint(entry: RemoteRuntimeEntry): string {
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
