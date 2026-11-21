import { Disposable } from '#/_base/di/lifecycle';
import type { Event, IWaitUntil } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IEnvironmentService, type EnvironmentResolver } from '#/app/environment/environment';
import { IMcpOAuthService } from '#/app/mcpConfig/oauthService';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import { McpConnectionManager, type McpServerEntry } from '#/mcpCore/connection-manager';
import type { McpOAuthEvent, McpOAuthService } from '#/mcpCore/oauth/service';
import { canonicalMcpOAuthResource } from '#/mcpCore/oauth/store';
import {
  IProjectMcpConfigService,
  type McpServersChange,
} from '#/project/projectMcpConfig/projectMcpConfig';

import { IProjectMcpService } from './projectMcp';

export interface McpSuppression {
  settled(): Promise<void>;
  current(): ReadonlySet<string>;
  readonly onDidChange: Event<IWaitUntil>;
}

export interface ProjectMcpServiceOptions {
  readonly stdioCwd: () => string;
  readonly onDidChangeStdioCwd?: Event<void>;
  readonly suppression?: McpSuppression;
}

const NO_NAMES: ReadonlySet<string> = new Set();

export class ProjectMcpService extends Disposable implements IProjectMcpService {
  declare readonly _serviceBrand: undefined;

  private readonly manager: McpConnectionManager;
  readonly ready: Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();
  private appliedStdioCwd?: string;
  private appliedSuppressed: ReadonlySet<string> = NO_NAMES;
  private definedFor?: Readonly<Record<string, McpServerConfig>>;
  private defined: ReadonlySet<string> = NO_NAMES;
  private shutdown?: Promise<void>;

  constructor(
    private readonly options: ProjectMcpServiceOptions,
    @IEnvironmentService private readonly environmentResolver: EnvironmentResolver,
    @IProjectMcpConfigService private readonly mcpConfig: IProjectMcpConfigService,
    @IMcpOAuthService oauthService: McpOAuthService,
    @ILogService private readonly log: ILogService,
    @IAgentIdentity private readonly identity: IAgentIdentity,
  ) {
    super();
    this.manager = new McpConnectionManager({
      log: this.log,
      oauthService,
      stdioCwd: options.stdioCwd,
      environmentResolver: this.environmentResolver,
      environmentId: 'local',
      reconnectRetryEnabled: true,
      resolveDefaults: () => this.mcpConfig.tunables(),
      resolveClientName: () => this.identity.current().slug,
    });
    this._register(
      this.mcpConfig.onDidChange((change) => {
        change.waitUntil(this.scheduleApply(change));
      }),
    );
    this._register(
      this.mcpConfig.onDidChangeTunables(() => {
        this.manager.rescheduleRetries();
      }),
    );
    if (options.onDidChangeStdioCwd !== undefined) {
      this._register(options.onDidChangeStdioCwd(() => this.scheduleStdioRebind()));
    }
    const suppression = options.suppression;
    if (suppression !== undefined) {
      this._register(
        suppression.onDidChange((event) => {
          event.waitUntil(this.scheduleSuppression(suppression));
        }),
      );
    }
    this._register({ dispose: subscribeMcpOAuthEvents(this.manager, oauthService, this.log) });
    this.ready = this.initialize().catch((error: unknown) => {
      this.log.error('mcp initial load failed', { error });
    });
  }

  override dispose(): void {
    void this.disposeAsync().catch((error) => {
      this.log.error('mcp disposal failed', { error });
    });
  }

  disposeAsync(): Promise<void> {
    this.shutdown ??= (async () => {
      let disposalError: unknown;
      try {
        super.dispose();
      } catch (error) {
        disposalError = error;
      }
      await this.manager.dispose();
      if (disposalError !== undefined) {
        throw disposalError instanceof Error
          ? disposalError
          : new Error('MCP disposal failed', { cause: disposalError });
      }
    })();
    return this.shutdown;
  }

  connectionManager(): McpConnectionManager {
    return this.manager;
  }

  definedNames(): ReadonlySet<string> {
    const servers = this.mcpConfig.servers();
    if (servers !== this.definedFor) {
      this.definedFor = servers;
      this.defined = new Set(Object.keys(servers));
    }
    return this.defined;
  }

  private mutate(work: () => Promise<void>): Promise<void> {
    const tail = this.mutationTail.catch(() => undefined).then(work);
    this.mutationTail = tail;
    return tail;
  }

  private afterReady(label: string, work: () => Promise<void>): Promise<void> {
    return this.ready
      .then(() => this.mutate(work))
      .catch((error) => {
        this.log.warn(`${label} failed: ${String(error)}`);
      });
  }

  private scheduleStdioRebind(): void {
    void this.afterReady('mcp primary reconnect', async () => {
      const cwd = this.options.stdioCwd();
      if (cwd === this.appliedStdioCwd) return;
      for (const [name, config] of Object.entries(this.mcpConfig.servers())) {
        if (config.transport !== 'stdio' || config.cwd !== undefined || config.enabled === false) {
          continue;
        }
        if (this.appliedSuppressed.has(name) || this.manager.get(name) === undefined) continue;
        try {
          await this.manager.reconnect(name);
        } catch (error) {
          this.log.warn(`mcp primary reconnect failed for ${name}: ${String(error)}`);
        }
      }
      this.appliedStdioCwd = cwd;
    });
  }

  private scheduleSuppression(suppression: McpSuppression): Promise<void> {
    return this.afterReady('mcp suppression apply', async () => {
      const next = suppression.current();
      const previous = this.appliedSuppressed;
      this.appliedSuppressed = next;
      await Promise.all(
        [...next].filter((name) => !previous.has(name)).map((name) => this.manager.markRemoved(name)),
      );
      const servers = this.mcpConfig.servers();
      await Promise.all(
        [...previous].flatMap((name) => {
          const config = next.has(name) || !Object.hasOwn(servers, name) ? undefined : servers[name];
          return config === undefined ? [] : [this.manager.connect(name, config)];
        }),
      );
    });
  }

  private async initialize(): Promise<void> {
    await this.mcpConfig.ready;
    await this.identity.resolved();
    await this.options.suppression?.settled();
    this.appliedStdioCwd = this.options.stdioCwd();
    this.appliedSuppressed = this.options.suppression?.current() ?? NO_NAMES;
    const servers = Object.fromEntries(
      Object.entries(this.mcpConfig.servers()).filter(([name]) => !this.appliedSuppressed.has(name)),
    );
    if (Object.keys(servers).length === 0) return;
    await this.manager.connectAll(servers);
  }

  private scheduleApply(change: McpServersChange): Promise<void> {
    return this.afterReady('mcp server change apply', () => this.apply(change));
  }

  private async apply(change: McpServersChange): Promise<void> {
    for (const name of change.remove) {
      await this.manager.markRemoved(name);
    }
    for (const [name, config] of Object.entries(change.upsert)) {
      if (this.appliedSuppressed.has(name)) continue;
      await this.manager.connect(name, config);
    }
  }
}

export function subscribeMcpOAuthEvents(
  manager: McpConnectionManager,
  oauthService: McpOAuthService,
  log: ILogService,
): () => void {
  return oauthService.onEvent((event) => {
    void handleMcpOAuthEvent(manager, oauthService, event).catch((error: unknown) => {
      log.warn(`mcp oauth event handling failed: ${String(error)}`);
    });
  });
}

async function handleMcpOAuthEvent(
  manager: McpConnectionManager,
  oauthService: McpOAuthService,
  event: McpOAuthEvent,
): Promise<void> {
  if (event.type === 'tokens-invalidated' && event.scope !== 'tokens' && event.scope !== 'all') {
    return;
  }
  const entry = manager.get(event.serverName);
  if (entry === undefined) return;
  const serverUrl = manager.getRemoteServerUrl(event.serverName);
  if (serverUrl === undefined || canonicalMcpOAuthResource(serverUrl) !== event.serverUrl) return;
  if (event.type === 'tokens-invalidated') {
    oauthService.forgetProvider(event.serverName, event.serverUrl);
    if (entry.status === 'needs-auth') return;
  }
  if (entry.status === 'disabled' || entry.status === 'removed') return;
  if (entry.status === 'pending') {
    await new Promise<void>((resolve, reject) => {
      let unsubscribe = (): void => {};
      let settled = false;
      const reconnect = (next: McpServerEntry | undefined): void => {
        if (settled) return;
        if (next !== undefined && (next.name !== event.serverName || next.status === 'pending')) {
          return;
        }
        settled = true;
        unsubscribe();
        if (next === undefined || next.status === 'disabled' || next.status === 'removed') {
          resolve();
          return;
        }
        void manager.reconnectAfterCurrent(event.serverName).then(resolve, reject);
      };
      unsubscribe = manager.onStatusChange(reconnect);
      if (settled) unsubscribe();
      else reconnect(manager.get(event.serverName));
    });
    return;
  }
  if (
    event.type === 'tokens-saved' &&
    entry.status !== 'needs-auth' &&
    entry.status !== 'failed'
  ) {
    return;
  }
  if (event.type === 'refresh-failed' && entry.status !== 'connected') return;
  await manager.reconnectAndJoin(event.serverName);
}
