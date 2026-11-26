import type { ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IConfigService } from '#/app/config/config';
import { IEnvironmentService, type EnvironmentResolver } from '#/app/environment/environment';
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
  ISessionMcpSources,
  MCP_SOURCE_PRIORITY,
  type McpSource,
} from '#/session/mcp/mcpSource';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';

export interface ISessionMcpService extends ISessionMcpHandle {
  registerSource(source: McpSource): IDisposable;
}

export const ISessionMcpService = ISessionMcpHandle as ServiceIdentifier<ISessionMcpService>;

export class SessionMcpService extends Disposable implements ISessionMcpService {
  declare readonly _serviceBrand: undefined;

  readonly connectionManager: McpConnectionView;
  readonly ready: Promise<void>;

  private readonly view = new MergedMcpConnectionView();
  private readonly registrations = new Map<string, IDisposable>();
  private readonly extraBaselineNames = new Set<string>();
  private readonly sharedViews: readonly McpConnectionView[];
  private readonly stdioCwd: () => string;
  private baseline?: Set<string>;
  private baselineFrozen = false;
  private shutdown?: Promise<void>;

  constructor(
    @ISessionContext private readonly context: ISessionContext,
    @ISessionEphemeralMcpServers ephemeralServers: Readonly<Record<string, McpServerConfig>>,
    @ISessionMcpSources initialSources: readonly McpSource[],
    @IConfigService private readonly config: IConfigService,
    @IMcpOAuthService private readonly oauthService: McpOAuthService,
    @IEnvironmentService private readonly environmentResolver: EnvironmentResolver,
    @IAgentIdentity private readonly identity: IAgentIdentity,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.connectionManager = this.view;
    this._register(this.view);
    this.sharedViews = initialSources.map((source) => source.view);
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
  }

  registerSource(source: McpSource): IDisposable {
    if (this.shutdown !== undefined) {
      void source.dispose?.();
      return toDisposable(() => {});
    }
    return this.attachSource(source);
  }

  isBaselineServer(name: string): boolean {
    const names = this.snapshotBaseline();
    if (names.has(name)) return true;
    if (this.baselineFrozen) return false;
    if (!this.sharedViews.some((view) => view.get(name) !== undefined)) return false;
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
      for (const registration of [...this.registrations.values()].toReversed()) {
        registration.dispose();
      }
      this.registrations.clear();
      super.dispose();
    })();
    return this.shutdown;
  }

  private attachSource(source: McpSource): IDisposable {
    this.registrations.get(source.id)?.dispose();
    const removeLayer = this.view.addLayer(source);
    const registration = toDisposable(() => {
      removeLayer.dispose();
      if (this.registrations.get(source.id) === registration) {
        this.registrations.delete(source.id);
      }
      void source.dispose?.();
    });
    this.registrations.set(source.id, registration);
    return registration;
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
    const registration = this.registerSource({
      id: 'caller',
      priority: MCP_SOURCE_PRIORITY.caller,
      ready: Promise.resolve(),
      view: manager,
      dispose: () => {
        unsubscribeOAuth();
        return manager.dispose();
      },
    });
    if (this.shutdown !== undefined) {
      registration.dispose();
      return;
    }
    await manager.connectAll({ ...servers }).catch((error: unknown) => {
      this.log.error('session mcp overlay initial load failed', { error });
    });
  }

  private snapshotBaseline(): Set<string> {
    if (this.baseline === undefined) {
      this.baseline = new Set<string>(this.extraBaselineNames);
      for (const view of this.sharedViews) {
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
