import type { ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
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
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionEphemeralMcpServers } from '#/session/mcp/ephemeralMcpServers';
import { MergedMcpConnectionView } from '#/session/mcp/mergedConnectionView';
import {
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
  private readonly extraBaselineNames = new Set<string>();
  private sharedBaselineViews: readonly McpConnectionView[];
  private readonly stdioCwd: () => string;
  private baseline?: Set<string>;
  private baselineFrozen = false;
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
    this.sharedBaselineViews = initialSources.map((source) => source.view);
    this.stdioCwd =
      initialSources.find((source) => source.stdioCwd !== undefined)?.stdioCwd ??
      (() => this.context.cwd ?? process.cwd());
    for (const source of initialSources) {
      this.attachSource(source);
    }
    for (const name of Object.keys(ephemeralServers)) {
      this.extraBaselineNames.add(name);
    }
    const sharedReady = Promise.all(initialSources.map((source) => source.ready)).then(
      () => undefined,
    );
    void sharedReady.then(
      () => this.freezeBaseline(),
      () => this.freezeBaseline(),
    );
    const ephemeralReady = this.attachEphemeralServers(ephemeralServers);
    this.ready = Promise.all([sharedReady, ephemeralReady]).then(() => undefined);
    this.reconcileEffectiveEntries();
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
    this.reconcileEffectiveEntries();
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

  isBaselineServer(name: string): boolean {
    const names = this.snapshotBaseline();
    if (names.has(name)) return true;
    if (this.baselineFrozen) return false;
    if (!this.sharedBaselineViews.some((view) => view.get(name) !== undefined)) return false;
    names.add(name);
    return true;
  }

  override dispose(): void {
    void this.disposeAsync().catch((error: unknown) => {
      this.log.error('session mcp disposal failed', { error });
    });
  }

  disposeAsync(): Promise<void> {
    this.shutdown ??= (async () => {
      for (const [id, source] of [...this.sources.entries()].toReversed()) {
        this.detachSource(id, source);
      }
      super.dispose();
    })();
    return this.shutdown;
  }

  private attachSource(source: McpSource): IDisposable {
    const previous = this.sources.get(source.id);
    if (previous !== undefined) {
      this.detachSource(source.id, previous);
    }
    this.sources.set(source.id, source);
    const subscription =
      source.onDidChangeEntries?.(() => this.reconcileEffectiveEntries()) ??
      toDisposable(() => {});
    this.sourceSubscriptions.set(source.id, subscription);
    this.sharedBaselineViews = [
      ...this.sharedBaselineViews.filter((view) => view !== previous?.view),
      source.view,
    ];
    this.syncSourceLayer(source);
    this.reconcileEffectiveEntries();
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
    this.sharedBaselineViews = this.sharedBaselineViews.filter((view) => view !== source.view);
    void source.dispose?.();
    this.reconcileEffectiveEntries();
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

  private reconcileEffectiveEntries(): void {
    const activeLayers = [...this.sources.values()]
      .filter((source) => !this.disabledSources.has(source.id))
      .toSorted((a, b) => a.priority - b.priority)
      .map((source) => source.entries());
    this.view.setEffectiveEntries(mergeMcpServerEntries(activeLayers));
  }

  private async attachEphemeralServers(
    servers: Readonly<Record<string, McpServerConfig>>,
  ): Promise<void> {
    if (Object.keys(servers).length === 0) return;
    await Promise.all([this.config.ready, this.identity.resolved()]);
    if (this.shutdown !== undefined) return;
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
    const unsubscribeOAuth = subscribeMcpOAuthEvents(this.oauthService, this.log, manager);
    const connecting = manager.connectAll({ ...servers }).catch((error: unknown) => {
      this.log.error('session mcp overlay initial load failed', { error });
    });
    const registration = this.registerSource({
      id: 'caller',
      priority: MCP_SOURCE_PRIORITY.caller,
      ready: connecting,
      view: manager,
      entries: () => servers,
      dispose: () => {
        unsubscribeOAuth();
        return manager.dispose();
      },
    });
    if (this.shutdown !== undefined) {
      registration.dispose();
      return;
    }
    await connecting;
  }

  private snapshotBaseline(): Set<string> {
    if (this.baseline === undefined) {
      this.baseline = new Set<string>(this.extraBaselineNames);
      for (const view of this.sharedBaselineViews) {
        for (const entry of view.list()) {
          this.baseline.add(entry.name);
        }
      }
    }
    return this.baseline;
  }

  private freezeBaseline(): void {
    this.snapshotBaseline();
    this.baselineFrozen = true;
  }
}
