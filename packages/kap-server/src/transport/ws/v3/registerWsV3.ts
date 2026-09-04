import {
  IEventService,
  ISessionIndex,
  ISessionManager,
  IWorkspaceService,
  type Scope,
  type Workspace,
} from '@moonshot-ai/agent-core-v2';
import { WebSocketServer } from 'ws';

import type { WorkspaceInfo } from '../../../protocol/messages';
import { resolveSessionFacts, toWireSession } from '../../../routes/sessions';
import { toWireWorkspace } from '../../../routes/workspaces';
import type { ProjectionService } from '../../../services/projection';
import { selectWsBearerProtocol } from '../bearerProtocol';
import type { IConnectionRegistry } from '../connectionRegistry';
import { WsConnectionV3 } from './wsConnectionV3';
import type { WsV3GlobalSource, WsV3Logger, WsV3SessionLifecycle } from './wsV3Deps';
import { WsV3Hub } from './wsV3Hub';

export const WS_PATH_V3 = '/api/v3/ws';

export interface RegisterWsV3Options {
  readonly registry: IConnectionRegistry;
  readonly projection: ProjectionService;
  readonly serverId: string;
  readonly logger?: WsV3Logger;
  readonly maxOutboundMessages?: number;
  readonly heartbeatIntervalMs?: number;
}

export interface WsV3Registration {
  readonly wss: WebSocketServer;
  readonly hub: WsV3Hub;
}

export function registerWsV3(core: Scope, opts: RegisterWsV3Options): WsV3Registration {
  const lifecycle: WsV3SessionLifecycle = {
    onDidCreateSession(listener) {
      const manager = core.accessor.get(ISessionManager);
      const event = manager.onDidCreateSession;
      if (event === undefined) return { dispose: () => {} };
      return event((created) => listener({ sessionId: created.sessionId }));
    },
    async sessionExists(sessionId) {
      return (await core.accessor.get(ISessionIndex).get(sessionId)) !== undefined;
    },
  };
  const globalSource: WsV3GlobalSource = {
    subscribe(listener) {
      return core.accessor.get(IEventService).subscribe((event) => {
        listener({
          type: event.type,
          payload: (event as { readonly payload?: unknown }).payload,
        });
      });
    },
    listWorkspaces: () => core.accessor.get(IWorkspaceService).list(),
    workspaceInfo: (workspace: Workspace): Promise<WorkspaceInfo> => toWireWorkspace(core, workspace),
    async sessionInfo(sessionId) {
      const summary = await core.accessor.get(ISessionIndex).get(sessionId);
      if (summary === undefined) return undefined;
      const cwd =
        summary.cwd ??
        (await core.accessor.get(IWorkspaceService).get(summary.workspaceId))?.root;
      if (cwd === undefined) return undefined;
      return toWireSession(summary, cwd, resolveSessionFacts(core, sessionId));
    },
  };
  const hub = new WsV3Hub({
    projection: opts.projection,
    lifecycle,
    globalSource,
    logger: opts.logger,
  });
  const wss = new WebSocketServer({ noServer: true, handleProtocols: selectWsBearerProtocol });
  wss.on('connection', (socket, req) => {
    const conn = new WsConnectionV3({
      socket,
      hub,
      connectionRegistry: opts.registry,
      remoteAddress: req.socket.remoteAddress ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      serverId: opts.serverId,
      logger: opts.logger,
      maxOutboundMessages: opts.maxOutboundMessages,
      heartbeatIntervalMs: opts.heartbeatIntervalMs,
    });
    socket.on('close', () => opts.registry.remove(conn.id));
  });
  return { wss, hub };
}
