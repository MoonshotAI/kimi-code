import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { LifecycleScope } from '#/app/scopes';

import { ISessionMcpOverlayConnection } from './sessionMcpOverlay';

export const SESSION_MCP_OVERLAY_CONNECT_TIMEOUT_MS = 5_000;

export interface ISessionMcpOverlayService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
}

export const ISessionMcpOverlayService: ServiceIdentifier<ISessionMcpOverlayService> =
  createDecorator<ISessionMcpOverlayService>('sessionMcpOverlayService');

export class SessionMcpOverlayService extends Service implements ISessionMcpOverlayService {
  declare readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  constructor(
    @ISessionMcpOverlayConnection connection: ISessionMcpOverlayConnection,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.ready = this.settle(connection);
  }

  private async settle(connection: ISessionMcpOverlayConnection): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), SESSION_MCP_OVERLAY_CONNECT_TIMEOUT_MS);
    });
    const outcome = await Promise.race([
      connection.ready.then(
        () => 'settled' as const,
        () => 'settled' as const,
      ),
      timeout,
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome !== 'timeout') return;
    this.log.warn('session mcp overlay connect timed out; continuing without session mcp servers');
    await connection.shutdown();
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionMcpOverlayService,
  SessionMcpOverlayService,
  ScopeActivation.OnDemand,
  'sessionMcpOverlay',
);
