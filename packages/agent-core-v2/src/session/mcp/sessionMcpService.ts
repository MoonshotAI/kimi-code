import type { ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IConfigService } from '#/app/config/config';
import { IEnvironmentService, type EnvironmentResolver } from '#/app/environment/environment';
import { mergeMcpServerEntries } from '#/app/mcpConfig/configLoader';
import { IMcpOAuthService } from '#/app/mcpConfig/oauthService';
import {
  MCP_SECTION,
  mcpTunablesFromSection,
  type McpSection,
} from '#/app/mcpConfig/configSection';
import {
  McpConnectionManager,
  type McpConnectionView,
} from '#/mcpCore/connection-manager';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import { subscribeMcpOAuthEvents } from '#/mcpCore/oauth/connectionBinding';
import type { McpOAuthService } from '#/mcpCore/oauth/service';
import { RefCountedMcpServerPool } from '#/mcpCore/refCountedPool';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionEphemeralMcpServers } from '#/session/mcp/ephemeralMcpServers';
import { MergedMcpConnectionView } from '#/session/mcp/mergedConnectionView';
import {
  arbitrateMcpSources,
  ISessionDisabledMcpSources,
  ISessionMcpSources,
  MCP_SOURCE_PRIORITY,
  type McpSource,
} from '#/session/mcp/mcpSource';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';

export interface SessionMcpSourceInfo {
  readonly id: string;
  readonly priority: number;
  readonly enabled: boolean;
}

export interface ISessionMcpService extends ISessionMcpHandle {
  registerSource(source: McpSource): IDisposable;
  setSourceEnabled(sourceId: string, enabled: boolean): void;
  isSourceEnabled(sourceId: string): boolean;
  listSources(): readonly SessionMcpSourceInfo[];
  upsertServer(name: string, config: McpServerConfig): Promise<void>;
}

export const ISessionMcpService = ISessionMcpHandle as ServiceIdentifier<ISessionMcpService>;

export class SessionMcpService extends Disposable implements ISessionMcpService {
  declare readonly _serviceBrand: undefined;

  readonly connectionManager: McpConnectionView;
  readonly ready: Promise<void>;

  private readonly view = new MergedMcpConnectionView();
  private readonly sources = new Map<string, McpSource>();
  private readonly layerDisposers = new Map<string, IDisposable>();
  private readonly sourceSubscriptions = new Map<string, IDisposable>();
  private readonly disabledSources: Set<string>;
  private readonly initialSourceIds = new Set<string>();
  private readonly extraBaselineNames = new Set<string>();
  private readonly runtimeEmitter = new Emitter<void>();
  private runtimeEntries: Readonly<Record<string, McpServerConfig>> = {};
  private runtimeSource?: McpSource;
  private readonly stdioCwd: () => string;
  private baseline?: Set<string>;
  private reconcileTail: Promise<void> = Promise.resolve();
  private shutdown?: Promise<void>;

  constructor(
    @ISessionContext private readonly context: ISessionContext,
    @ISessionEphemeralMcpServers ephemeralServers: Readonly<Record<string, McpServerConfig>>,
    @ISessionMcpSources initialSources: readonly McpSource[],
    @ISessionDisabledMcpSources disabledSources: readonly string[],
    @IConfigService private readonly config: IConfigService,
    @IMcpOAuthService private readonly oauthService: McpOAuthService,
    @IEnvironmentService private readonly environmentResolver: EnvironmentResolver,
    @IAgentIdentity private readonly identity: IAgentIdentity,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.connectionManager = this.view;
    this._register(this.view);
    this.disabledSources = new Set(disabledSources);
    this.stdioCwd =
      initialSources.find((source) => source.stdioCwd !== undefined)?.stdioCwd ??
      (() => this.context.cwd ?? process.cwd());
    for (const source of initialSources) {
      this.initialSourceIds.add(source.id);
      this.attachSource(source);
    }
    for (const name of Object.keys(ephemeralServers)) {
      this.extraBaselineNames.add(name);
    }
    if (Object.keys(ephemeralServers).length > 0) {
      this.attachSource(
        this.createSessionSource('caller', MCP_SOURCE_PRIORITY.caller, () => ephemeralServers),
      );
    }
    this.projectEffectiveEntries();
    const configReady = Promise.all([
      this.config.ready,
      this.identity.resolved(),
      ...initialSources.map((source) => source.ready),
    ]).then(() => undefined);
    this.ready = configReady.then(async () => {
      if (this.shutdown !== undefined) return;
      this.configSettled = true;
      this.freezeBaseline();
      this.projectEffectiveEntries();
      await this.scheduleAcquire();
      await this.reconcileTail;
    });
  }

  registerSource(source: McpSource): IDisposable {
    if (this.shutdown !== undefined) {
      void source.dispose?.();
      return toDisposable(() => {});
    }
    return this.attachSource(source);
  }

  setSourceEnabled(sourceId: string, enabled: boolean): void {
    if (enabled) {
      if (!this.disabledSources.delete(sourceId)) return;
    } else if (this.disabledSources.has(sourceId)) {
      return;
    } else {
      this.disabledSources.add(sourceId);
    }
    const source = this.sources.get(sourceId);
    if (source !== undefined) {
      this.syncSourceLayer(source);
    }
    this.projectEffectiveEntries();
    void this.scheduleAcquire();
  }

  isSourceEnabled(sourceId: string): boolean {
    return !this.disabledSources.has(sourceId);
  }

  listSources(): readonly SessionMcpSourceInfo[] {
    return [...this.sources.values()]
      .toSorted((a, b) => a.priority - b.priority)
      .map((source) => ({
        id: source.id,
        priority: source.priority,
        enabled: !this.disabledSources.has(source.id),
      }));
  }

  async upsertServer(name: string, config: McpServerConfig): Promise<void> {
    if (this.shutdown !== undefined) return;
    this.runtimeEntries = { ...this.runtimeEntries, [name]: config };
    if (this.runtimeSource === undefined) {
      this.runtimeSource = this.createSessionSource(
        'runtime',
        MCP_SOURCE_PRIORITY.runtime,
        () => this.runtimeEntries,
        this.runtimeEmitter.event,
      );
      this.attachSource(this.runtimeSource);
    } else {
      this.runtimeEmitter.fire();
    }
    this.projectEffectiveEntries();
    await this.scheduleAcquire();
    await this.reconcileTail;
  }

  isBaselineServer(name: string): boolean {
    if (this.baseline !== undefined) return this.baseline.has(name);
    if (this.extraBaselineNames.has(name)) return true;
    return this.activeSourcesAscending().some(
      (source) => this.initialSourceIds.has(source.id) && Object.hasOwn(source.entries(), name),
    );
  }

  override dispose(): void {
    void this.disposeAsync().catch((error: unknown) => {
      this.log.error('session mcp disposal failed', { error });
    });
  }

  disposeAsync(): Promise<void> {
    this.shutdown ??= (async () => {
      const sources = [...this.sources.values()];
      await Promise.allSettled(
        sources.flatMap((source) =>
          source.release === undefined ? [] : [source.release(this.context.sessionId)],
        ),
      );
      for (const [id, source] of [...this.sources.entries()].toReversed()) {
        this.detachSource(id, source);
      }
      super.dispose();
    })();
    return this.shutdown;
  }

  private createSessionSource(
    id: string,
    priority: number,
    entries: () => Readonly<Record<string, McpServerConfig>>,
    onDidChangeEntries?: Event<void>,
  ): McpSource {
    const manager = new McpConnectionManager({
      log: this.log,
      oauthService: this.oauthService,
      stdioCwd: this.stdioCwd,
      environmentResolver: this.environmentResolver,
      environmentId: 'local',
      requireStdioEnvironmentId: true,
      reconnectRetryEnabled: true,
      sessionId: this.context.sessionId,
      resolveDefaults: () =>
        mcpTunablesFromSection(this.config.get<McpSection | undefined>(MCP_SECTION)),
      resolveClientName: () => this.identity.current().slug,
    });
    const pool = new RefCountedMcpServerPool(manager);
    const unsubscribeOAuth = subscribeMcpOAuthEvents(this.oauthService, this.log, manager);
    return {
      id,
      priority,
      ready: Promise.resolve(),
      view: manager,
      entries,
      onDidChangeEntries,
      acquire: (ownerId, active) => pool.acquire(ownerId, active),
      release: (ownerId) => pool.release(ownerId),
      dispose: () => {
        unsubscribeOAuth();
        return manager.dispose();
      },
    };
  }

  private attachSource(source: McpSource): IDisposable {
    const previous = this.sources.get(source.id);
    if (previous !== undefined) {
      this.detachSource(source.id, previous);
    }
    this.sources.set(source.id, source);
    const subscription =
      source.onDidChangeEntries?.(() => {
        this.projectEffectiveEntries();
        void this.scheduleAcquire();
      }) ?? toDisposable(() => {});
    this.sourceSubscriptions.set(source.id, subscription);
    this.syncSourceLayer(source);
    this.projectEffectiveEntries();
    void this.scheduleAcquire();
    return toDisposable(() => {
      if (this.sources.get(source.id) === source) {
        this.detachSource(source.id, source);
      }
    });
  }

  private detachSource(id: string, source: McpSource): void {
    this.layerDisposers.get(id)?.dispose();
    this.layerDisposers.delete(id);
    this.sourceSubscriptions.get(id)?.dispose();
    this.sourceSubscriptions.delete(id);
    this.sources.delete(id);
    void source.release?.(this.context.sessionId);
    void source.dispose?.();
    this.projectEffectiveEntries();
    void this.scheduleAcquire();
  }

  private syncSourceLayer(source: McpSource): void {
    if (this.disabledSources.has(source.id)) {
      this.layerDisposers.get(source.id)?.dispose();
      this.layerDisposers.delete(source.id);
      return;
    }
    if (this.layerDisposers.has(source.id)) return;
    this.layerDisposers.set(source.id, this.view.addLayer(source));
  }

  private activeSourcesAscending(): McpSource[] {
    return [...this.sources.values()]
      .filter((source) => !this.disabledSources.has(source.id))
      .toSorted((a, b) => a.priority - b.priority);
  }

  private projectEffectiveEntries(): void {
    const activeSources = this.activeSourcesAscending();
    const activeLayers = activeSources.map((source) => source.entries());
    const activatingNames = new Set<string>();
    if (this.configSettled) {
      for (const configs of arbitrateMcpSources(activeSources).values()) {
        for (const name of Object.keys(configs)) activatingNames.add(name);
      }
    }
    this.view.setEffectiveEntries(mergeMcpServerEntries(activeLayers), activatingNames);
  }

  private configSettled = false;
  private acquireGeneration = 0;

  private scheduleAcquire(): Promise<void> {
    const generation = ++this.acquireGeneration;
    const work = async (): Promise<void> => {
      if (this.shutdown !== undefined) return;
      if (!this.configSettled) return;
      if (generation !== this.acquireGeneration) return;
      const winnersBySource = arbitrateMcpSources(this.activeSourcesAscending());
      await Promise.allSettled(
        [...this.sources.values()].flatMap((source) =>
          source.acquire === undefined
            ? []
            : [
                source.acquire(
                  this.context.sessionId,
                  this.disabledSources.has(source.id)
                    ? {}
                    : (winnersBySource.get(source.id) ?? {}),
                ),
              ],
        ),
      );
    };
    const next = this.reconcileTail.catch(() => undefined).then(work);
    this.reconcileTail = next;
    return next;
  }

  private freezeBaseline(): void {
    if (this.baseline !== undefined) return;
    const sharedLayers = this.activeSourcesAscending()
      .filter((source) => this.initialSourceIds.has(source.id))
      .map((source) => source.entries());
    this.baseline = new Set<string>([
      ...this.extraBaselineNames,
      ...Object.keys(mergeMcpServerEntries(sharedLayers)),
    ]);
  }
}
