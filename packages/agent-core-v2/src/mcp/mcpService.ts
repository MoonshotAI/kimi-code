/**
 * `mcp` domain (L5) — `IMcpService` implementation.
 *
 * Tracks MCP server connection state and emits `onDidChangeServerStatus`.
 * Tool fan-out to agents (via `IAgentLifecycleService` →
 * `IToolService.registerMcpTools`) is wired in a later step.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IOAuthService } from '#/auth/auth';
import { IConfigService } from '#/config/config';
import { ILogService } from '#/log/log';
import { ITelemetryService } from '#/telemetry/telemetry';

import { type McpServerStatusEvent, IMcpService } from './mcp';

export class McpService extends Disposable implements IMcpService {
  declare readonly _serviceBrand: undefined;
  private readonly _onDidChangeServerStatus = this._register(
    new Emitter<McpServerStatusEvent>(),
  );
  readonly onDidChangeServerStatus: Event<McpServerStatusEvent> =
    this._onDidChangeServerStatus.event;
  private readonly servers = new Map<string, string>();

  constructor(
    @IConfigService _config: IConfigService,
    @ILogService _log: ILogService,
    @ITelemetryService _telemetry: ITelemetryService,
    @IOAuthService _oauth: IOAuthService,
  ) {
    super();
  }

  connect(serverId: string): Promise<void> {
    this.servers.set(serverId, 'connected');
    this._onDidChangeServerStatus.fire({ serverId, status: 'connected' });
    return Promise.resolve();
  }

  disconnect(serverId: string): Promise<void> {
    this.servers.delete(serverId);
    this._onDidChangeServerStatus.fire({ serverId, status: 'disconnected' });
    return Promise.resolve();
  }

  list(): readonly string[] {
    return [...this.servers.keys()];
  }
}

registerScopedService(LifecycleScope.Session, IMcpService, McpService, InstantiationType.Delayed, 'mcp');
