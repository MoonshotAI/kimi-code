import { randomUUID } from 'node:crypto';
import * as posixPath from 'node:path/posix';

import { Emitter } from '@moonshot-ai/agent-core-v2/_base/event';
import { ILogService } from '@moonshot-ai/agent-core-v2/_base/log/log';
import { IConfigService } from '@moonshot-ai/agent-core-v2/app/config/config';
import { IFlagService } from '@moonshot-ai/agent-core-v2/app/flag/flag';
import type { HostEnvironmentInfo } from '@moonshot-ai/agent-core-v2/os/interface/hostEnvironment';
import { IHostFileSystem } from '@moonshot-ai/agent-core-v2/os/interface/hostFileSystem';
import { IAtomicDocumentStore } from '@moonshot-ai/agent-core-v2/persistence/interface/atomicDocumentStore';
import { REMOTE_RUNTIME_FLAG_ID } from '@moonshot-ai/agent-core-v2/runtime/flag';
import {
  resolveWorkspaceRuntimeDeclarations,
} from '@moonshot-ai/agent-core-v2/runtime/runtimeDeclarations';
import type {
  RemoteRuntimeDeclaration,
  RemoteRuntimeEntry,
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

  constructor(
    private readonly inner: RemoteRuntime | undefined,
    private readonly connectCallback: () => Promise<void>,
    pendingIdentity?: RuntimeIdentity,
  ) {
    if (inner === undefined) {
      if (pendingIdentity === undefined) throw new Error('pending managed runtime requires an identity');
      this.identity = pendingIdentity;
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
      this.identity = inner.identity;
      this.capabilities = inner.capabilities;
      this.environment = inner.environment;
      this.path = inner.path;
      this.workspace = inner.workspace;
      this.currentStatus = inner.status;
      this.statusSubscription = inner.onDidChangeStatus((status) => {
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

  connect(): Promise<void> {
    return this.connectCallback();
  }

  private setStatus(status: RuntimeStatus): void {
    if (this.currentStatus === status || this.currentStatus === 'disposed') return;
    this.currentStatus = status;
    this.statusEmitter.fire(status);
  }

  async dispose(): Promise<void> {
    this.statusSubscription?.dispose();
    if (this.currentStatus !== 'disposed') {
      this.currentStatus = 'disposed';
      this.statusEmitter.fire('disposed');
    }
    this.statusEmitter.dispose();
    await this.inner?.dispose();
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
}

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
    let declarations: readonly RemoteRuntimeDeclaration[];
    try {
      const resolved = await resolveWorkspaceRuntimeDeclarations({
        config: host.get(IConfigService),
        fs: host.get(IHostFileSystem),
        docs: host.get(IAtomicDocumentStore),
        root: context.root,
      });
      if (resolved.projectError !== undefined) {
        log.warn('project remote runtime declarations failed to load', { error: resolved.projectError });
      }
      declarations = resolved.entries;
    } catch (error) {
      log.warn('remote runtime declarations failed to load', { error });
      return {
        dispose() {},
      };
    }
    const handles: RuntimeProviderRuntimeHandle[] = [];
    for (const declaration of declarations) {
      handles.push(this.registerDeclaredRuntime(context, host, declaration));
    }
    return {
      dispose: async () => {
        for (const handle of [...handles].toReversed()) await handle.remove();
      },
    };
  }

  private registerDeclaredRuntime(
    context: RuntimeProviderContext,
    host: RuntimeProviderHost,
    declaration: RemoteRuntimeDeclaration,
  ): RuntimeProviderRuntimeHandle {
    let handle!: RuntimeProviderRuntimeHandle;
    let inflight: Promise<void> | undefined;
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
          await handle.update(() => new ManagedRemoteRuntime(connected, connectRuntime));
        } finally {
          inflight = undefined;
        }
      })();
      return inflight;
    };
    handle = host.registerRuntime(
      new ManagedRemoteRuntime(undefined, connectRuntime, {
        workspaceId: context.id,
        runtimeId: declaration.id,
        generation: `${declaration.id}-pending-${randomUUID()}`,
      }),
    );
    return handle;
  }
}
