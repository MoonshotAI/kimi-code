import type { IDisposable } from '#/_base/di/lifecycle';
import { AsyncEmitter, Emitter, type Event, type IWaitUntil } from '#/_base/event';
import type { IEnvironmentService } from '#/app/environment/environment';
import {
  findMcpAnchor,
  keyedRootAnchor,
  loadAnchorMcpServers,
  type KeyedMcpAnchor,
  type McpAnchor,
  type McpAnchorScope,
} from '#/app/mcpConfig/configLoader';
import { McpConnectionManager, type McpConnectionView } from '#/mcpCore/connection-manager';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { LayeredMcpConnectionView, type McpViewLayer } from '#/session/mcp/layeredConnectionView';
import type { IProjectDirs } from '#/project/projectDirs/projectDirs';
import type {
  ProjectMcpPreview,
  ProjectMcpServer,
  SessionMcpLease,
  SessionMcpOptions,
  WorkdirMcp,
} from '#/project/projectMcp/projectMcp';
import {
  ProjectMcpService,
  subscribeMcpOAuthEvents,
} from '#/project/projectMcp/projectMcpService';
import { ProjectMcpConfigService } from '#/project/projectMcpConfig/projectMcpConfigService';
import type { IProjectTrust } from '#/project/projectTrust/projectTrust';

import type { ProgramDependencies } from './programDependencies';

export interface McpProjectScope {
  current(): Promise<McpAnchorScope>;
  readonly onDidChange: Event<void>;
}

export interface ProgramMcpDeps
  extends Pick<
    ProgramDependencies,
    'bootstrap' | 'config' | 'configStore' | 'identity' | 'log' | 'oauth' | 'plugins' | 'telemetry'
  > {
  readonly environments: IEnvironmentService;
  readonly hostFs: IHostFileSystem;
  readonly project: McpProjectScope;
  readonly rootDirs: IProjectDirs;
  readonly trust: IProjectTrust;
}

interface McpAnchorLease extends IDisposable {
  readonly key: string;
  readonly anchor: McpAnchor;
  readonly config: ProjectMcpConfigService;
  readonly service: ProjectMcpService;
  readonly layer: McpViewLayer;
}

interface EphemeralMcp {
  readonly layer: McpViewLayer;
  readonly ready: Promise<void>;
  dispose(): Promise<void>;
}

interface WorkdirMcpHost {
  readonly user: ProjectMcpService;
  readonly userConfig: ProjectMcpConfigService;
  readonly userLayer: McpViewLayer;
  acquireAnchor(anchor: KeyedMcpAnchor): McpAnchorLease;
  suppressionSettled(): Promise<void>;
  openEphemeral(options: SessionMcpOptions, stdioCwd: string): EphemeralMcp;
  forget(workdir: AnchoredWorkdirMcp): void;
}

const NO_ABORT = new AbortController().signal;

export class ProgramMcp implements ProjectMcpPreview {
  readonly root: WorkdirMcp;
  private readonly rootWorkdir: AnchoredWorkdirMcp;
  private readonly userConfig: ProjectMcpConfigService;
  private readonly user: ProjectMcpService;
  private readonly anchors = new Map<string, AnchorEntry>();
  private readonly pinned = new Map<AnchoredWorkdirMcp, string>();
  private readonly workdirHost: WorkdirMcpHost;
  private readonly suppressionEmitter = new AsyncEmitter<IWaitUntil>();
  private suppressed: ReadonlySet<string> = new Set();
  private suppressionApplied: Promise<void> = Promise.resolve();
  private anchoring: Promise<void> = Promise.resolve();
  private readonly subscriptions: readonly IDisposable[];
  private readonly releasing = new Set<Promise<void>>();
  private disposal?: Promise<void>;
  private disposed = false;

  constructor(private readonly deps: ProgramMcpDeps) {
    this.userConfig = new ProjectMcpConfigService(
      { kind: 'user' },
      deps.bootstrap,
      deps.plugins,
      deps.log,
      deps.config,
      deps.hostFs,
      deps.trust,
      deps.configStore,
      deps.oauth,
    );
    this.user = new ProjectMcpService(
      {
        stdioCwd: () => deps.rootDirs.primary,
        onDidChangeStdioCwd: deps.rootDirs.onDidChange,
        suppression: {
          settled: () => this.anchorsSettled(),
          current: () => this.suppressed,
          onDidChange: this.suppressionEmitter.event,
        },
      },
      deps.environments,
      this.userConfig,
      deps.oauth,
      deps.log,
      deps.identity,
    );
    this.workdirHost = {
      user: this.user,
      userConfig: this.userConfig,
      userLayer: layerOf(this.user),
      acquireAnchor: (anchor) => this.acquireAnchor(anchor),
      suppressionSettled: () => this.anchorsSettled().then(() => this.suppressionApplied),
      openEphemeral: (options, stdioCwd) => this.openEphemeral(options, stdioCwd),
      forget: (workdir) => this.pinned.delete(workdir),
    };
    this.rootWorkdir = new AnchoredWorkdirMcp(
      this.workdirHost,
      keyedRootAnchor(deps.rootDirs.primary),
      () => deps.rootDirs.primary,
    );
    this.root = this.rootWorkdir;
    this.subscriptions = [
      deps.rootDirs.onDidChange(() => {
        this.rootWorkdir.moveTo(keyedRootAnchor(deps.rootDirs.primary));
      }),
      deps.project.onDidChange(() => {
        this.reanchorPinned();
      }),
    ];
    void this.rootWorkdir.ready.then(() => this.trackInitialLoad());
  }

  workdir(workDir: string): Promise<WorkdirMcp & IDisposable> {
    return this.serializeAnchoring(async () => {
      const workdir = new AnchoredWorkdirMcp(this.workdirHost, await this.anchorFor(workDir), () => workDir);
      this.pinned.set(workdir, workDir);
      return workdir;
    });
  }

  async previewProjectServers(pinnedWorkDir?: string): Promise<readonly ProjectMcpServer[]> {
    const anchor = pinnedWorkDir === undefined ? this.root.anchor : (await this.anchorFor(pinnedWorkDir)).anchor;
    const loaded = await loadAnchorMcpServers({ fs: this.deps.hostFs, anchor });
    return Object.entries(loaded.servers).flatMap(([name, config]) => {
      const origin = loaded.origins[name];
      return origin === undefined ? [] : [{ name, config, origin }];
    });
  }

  dispose(): Promise<void> {
    this.disposal ??= this.shutdownAll();
    return this.disposal;
  }

  private async shutdownAll(): Promise<void> {
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    const entries = [...this.anchors.values()];
    this.anchors.clear();
    this.rootWorkdir.dispose();
    this.suppressionEmitter.dispose();
    const results = await Promise.allSettled([
      ...this.releasing,
      ...entries.map((entry) => entry.shutdown()),
      this.user.disposeAsync().finally(() => {
        this.userConfig.dispose();
      }),
    ]);
    const errors: unknown[] = [];
    for (const result of results) {
      if (result.status === 'rejected') errors.push(result.reason);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'program MCP disposal failed');
  }

  private async anchorFor(workDir: string): Promise<KeyedMcpAnchor> {
    return findMcpAnchor(this.deps.hostFs, workDir, await this.deps.project.current());
  }

  private serializeAnchoring<T>(work: () => Promise<T>): Promise<T> {
    const run = this.anchoring.then(work);
    this.anchoring = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private reanchorPinned(): void {
    void this.serializeAnchoring(async () => {
      for (const [workdir, workDir] of this.pinned) {
        workdir.moveTo(await this.anchorFor(workDir));
      }
    }).catch((error: unknown) => {
      this.deps.log.warn(`mcp anchor refresh failed: ${String(error)}`);
    });
  }

  private acquireAnchor({ anchor, key }: KeyedMcpAnchor): McpAnchorLease {
    if (this.disposed) throw new Error('program MCP is disposed');
    let entry = this.anchors.get(key);
    if (entry === undefined) {
      entry = this.createAnchorEntry(anchor);
      this.anchors.set(key, entry);
    }
    entry.references += 1;
    const acquired = entry;
    let released = false;
    return {
      key,
      anchor: acquired.anchor,
      config: acquired.config,
      service: acquired.service,
      layer: acquired.layer,
      dispose: () => {
        if (released) return;
        released = true;
        this.releaseAnchor(key, acquired);
      },
    };
  }

  private createAnchorEntry(anchor: McpAnchor): AnchorEntry {
    const config = new ProjectMcpConfigService(
      { kind: 'workdir', anchor },
      this.deps.bootstrap,
      this.deps.plugins,
      this.deps.log,
      this.deps.config,
      this.deps.hostFs,
      this.deps.trust,
      this.deps.configStore,
      this.deps.oauth,
    );
    const service = new ProjectMcpService(
      { stdioCwd: () => anchor },
      this.deps.environments,
      config,
      this.deps.oauth,
      this.deps.log,
      this.deps.identity,
    );
    return new AnchorEntry(anchor, config, service, () => this.reconcileSuppression());
  }

  private releaseAnchor(key: string, entry: AnchorEntry): void {
    entry.references -= 1;
    if (entry.references > 0 || this.anchors.get(key) !== entry) return;
    this.anchors.delete(key);
    const releasing = entry
      .shutdown()
      .catch((error: unknown) => {
        this.deps.log.error('mcp anchor layer disposal failed', { anchor: entry.anchor, error });
      })
      .finally(() => {
        this.releasing.delete(releasing);
      });
    this.releasing.add(releasing);
    this.reconcileSuppression();
  }

  private anchorsSettled(): Promise<void> {
    return Promise.all([...this.anchors.values()].map((entry) => entry.settled)).then(() => undefined);
  }

  private reconcileSuppression(): void {
    const live = [...this.anchors.values()];
    if (this.disposed || live.some((entry) => !entry.ready)) return;
    const next = suppressedUserServers(live.map((entry) => entry.service.definedNames()));
    if (sameNames(next, this.suppressed)) return;
    this.suppressed = next;
    this.suppressionApplied = this.suppressionEmitter.fireAsync({}, NO_ABORT);
  }

  private openEphemeral(options: SessionMcpOptions, stdioCwd: string): EphemeralMcp {
    const manager = new McpConnectionManager({
      log: this.deps.log,
      oauthService: this.deps.oauth,
      stdioCwd,
      environmentResolver: this.deps.environments,
      environmentId: 'local',
      requireStdioEnvironmentId: true,
      reconnectRetryEnabled: true,
      sessionId: options.sessionId,
      resolveDefaults: () => this.userConfig.tunables(),
      resolveClientName: () => this.deps.identity.current().slug,
    });
    const names = new Set(Object.keys(options.ephemeral));
    const ready = Promise.all([this.userConfig.ready, this.deps.identity.resolved()])
      .then(() => manager.connectAll({ ...options.ephemeral }))
      .catch((error: unknown) => {
        this.deps.log.error('session mcp overlay initial load failed', { error });
      });
    const unsubscribeOAuth = subscribeMcpOAuthEvents(manager, this.deps.oauth, this.deps.log);
    return {
      layer: { manager, owns: (name) => names.has(name) },
      ready,
      dispose: () => {
        unsubscribeOAuth();
        return manager.dispose();
      },
    };
  }

  private trackInitialLoad(): void {
    const entries = this.root.view().list().filter((entry) => entry.status !== 'disabled');
    const totalCount = entries.length;
    if (totalCount === 0) return;

    const connectedCount = entries.filter((entry) => entry.status === 'connected').length;
    if (connectedCount > 0) {
      this.deps.telemetry.track2('mcp_connected', {
        server_count: connectedCount,
        total_count: totalCount,
      });
    }

    const failedCount = entries.filter((entry) => entry.status === 'failed').length;
    if (failedCount > 0) {
      this.deps.telemetry.track2('mcp_failed', {
        failed_count: failedCount,
        total_count: totalCount,
      });
    }
  }
}

export function suppressedUserServers(
  anchorNames: Iterable<ReadonlySet<string>>,
): ReadonlySet<string> {
  let shared: Set<string> | undefined;
  for (const names of anchorNames) {
    shared = shared === undefined ? new Set(names) : new Set([...shared].filter((name) => names.has(name)));
  }
  return shared ?? new Set();
}

class AnchorEntry {
  references = 0;
  ready = false;
  readonly settled: Promise<void>;
  readonly layer: McpViewLayer;
  private readonly subscription: IDisposable;

  constructor(
    readonly anchor: McpAnchor,
    readonly config: ProjectMcpConfigService,
    readonly service: ProjectMcpService,
    onDidChange: () => void,
  ) {
    this.layer = layerOf(service);
    this.settled = config.ready.then(() => {
      this.ready = true;
      onDidChange();
    });
    this.subscription = config.onDidChange(() => {
      onDidChange();
    });
  }

  async shutdown(): Promise<void> {
    this.subscription.dispose();
    try {
      await this.service.disposeAsync();
    } finally {
      this.config.dispose();
    }
  }
}

class AnchoredWorkdirMcp implements WorkdirMcp, IDisposable {
  private lease: McpAnchorLease;
  private readonly layersEmitter = new Emitter<void>();
  readonly onDidChangeAnchor: Event<void> = this.layersEmitter.event;
  private readonly baseView: LayeredMcpConnectionView;
  private disposed = false;

  constructor(
    private readonly host: WorkdirMcpHost,
    anchor: KeyedMcpAnchor,
    private readonly workDir: () => string,
  ) {
    this.lease = host.acquireAnchor(anchor);
    this.baseView = new LayeredMcpConnectionView(
      () => [this.lease.layer],
      host.userLayer,
      this.layersEmitter.event,
    );
  }

  get anchor(): McpAnchor {
    return this.lease.anchor;
  }

  get ready(): Promise<void> {
    return Promise.all([
      this.host.user.ready,
      this.lease.service.ready,
      this.host.suppressionSettled(),
    ]).then(() => undefined);
  }

  view(): McpConnectionView {
    return this.baseView;
  }

  configuredNames(): readonly string[] {
    return [
      ...new Set([
        ...Object.keys(this.host.userConfig.servers()),
        ...Object.keys(this.lease.config.servers()),
      ]),
    ];
  }

  sessionHandle(options: SessionMcpOptions): SessionMcpLease {
    const ready = this.ready;
    const ephemeralNames = Object.keys(options.ephemeral);
    if (ephemeralNames.length === 0) {
      return {
        handle: {
          _serviceBrand: undefined,
          ready,
          connectionManager: this.baseView,
          isBaselineServer: sessionBaseline(this.baseView, ready),
          upsertTarget: (name) => this.upsertTarget(name),
        },
        dispose: () => Promise.resolve(),
      };
    }
    const ephemeral = this.host.openEphemeral(options, this.workDir());
    const view = new LayeredMcpConnectionView(
      () => [ephemeral.layer, this.lease.layer],
      this.host.userLayer,
      this.layersEmitter.event,
    );
    return {
      handle: {
        _serviceBrand: undefined,
        ready: Promise.all([ready, ephemeral.ready]).then(() => undefined),
        connectionManager: view,
        isBaselineServer: sessionBaseline(this.baseView, ready, ephemeralNames),
      },
      dispose: () => ephemeral.dispose(),
    };
  }

  moveTo(anchor: KeyedMcpAnchor): void {
    if (this.disposed || anchor.key === this.lease.key) return;
    const previous = this.lease;
    this.lease = this.host.acquireAnchor(anchor);
    this.layersEmitter.fire();
    previous.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.host.forget(this);
    this.layersEmitter.dispose();
    this.lease.dispose();
  }

  private upsertTarget(name: string): McpConnectionManager {
    return this.lease.service.definedNames().has(name)
      ? this.lease.service.connectionManager()
      : this.host.user.connectionManager();
  }
}

function layerOf(service: ProjectMcpService): McpViewLayer {
  const manager = service.connectionManager();
  return { manager, owns: (name) => service.definedNames().has(name) };
}

function sameNames(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((name) => b.has(name));
}

function sessionBaseline(
  view: McpConnectionView,
  ready: Promise<void>,
  extra?: readonly string[],
): (name: string) => boolean {
  let baseline: Set<string> | undefined;
  let frozen = false;
  const snapshot = (): Set<string> => {
    if (baseline === undefined) {
      baseline = new Set<string>(extra);
      for (const entry of view.list()) {
        baseline.add(entry.name);
      }
    }
    return baseline;
  };
  void ready.then(
    () => {
      snapshot();
      frozen = true;
    },
    () => {
      snapshot();
      frozen = true;
    },
  );
  return (name) => {
    const names = snapshot();
    if (names.has(name)) return true;
    if (frozen) return false;
    if (view.get(name) === undefined) return false;
    names.add(name);
    return true;
  };
}
