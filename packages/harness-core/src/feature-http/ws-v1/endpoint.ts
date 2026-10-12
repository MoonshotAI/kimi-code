import { useApp, useCleanup, useOnApp } from '@moonshot-ai/agent-core';
import { useExpose } from '@moonshot-ai/agent-core/kernel/index';

import { WebSocketServer } from 'ws';

import { useHttp } from '../feature';
import type { WsRegistryStore } from '../ws-registry';

import { WsV1Connection } from './connection';
import { selectBearerProtocol } from './protocol';
import { SessionBroadcaster, WsV1BroadcasterRef } from './sessionState';

const DEFAULT_MAX_BUFFER_SIZE = 1000;

export interface WsV1EndpointOptions {
  readonly prefix: string;
  readonly registry: WsRegistryStore;
  readonly heartbeatIntervalMs?: number;
}

export function useWsV1Endpoint(options: WsV1EndpointOptions): void {
  const app = useApp();
  const http = useHttp();
  const path = `${options.prefix.replace(/\/+$/, '')}/ws`;
  const broadcaster = new SessionBroadcaster({ app, maxBufferSize: DEFAULT_MAX_BUFFER_SIZE });
  useExpose(WsV1BroadcasterRef, broadcaster);
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => selectBearerProtocol(protocols),
  });
  const connections = new Map<string, WsV1Connection>();

  useOnApp('session.created', (event) => {
    const sessionId = (event as { sessionId?: unknown }).sessionId;
    if (typeof sessionId === 'string') broadcaster.onSessionCreated(sessionId);
  });
  useOnApp('session.deleted', (event) => {
    const sessionId = (event as { sessionId?: unknown }).sessionId;
    if (typeof sessionId === 'string') broadcaster.onSessionDeleted(sessionId);
  });
  useOnApp('workspace.created', (event) => {
    broadcaster.onWorkspaceEvent('event.workspace.created', workspaceWireOf(event));
  });
  useOnApp('workspace.updated', (event) => {
    broadcaster.onWorkspaceEvent('event.workspace.updated', workspaceWireOf(event));
  });
  useOnApp('workspace.deleted', (event) => {
    const payload = event as { workspaceId?: unknown; root?: unknown };
    if (typeof payload.workspaceId !== 'string') return;
    broadcaster.onWorkspaceEvent('event.workspace.deleted', {
      workspace_id: payload.workspaceId,
      root: typeof payload.root === 'string' ? payload.root : '',
      agentId: 'main',
    });
  });
  useOnApp('plugin.changed', () => {
    broadcaster.onGlobalEvent('event.plugin.changed', { agentId: 'main' });
  });
  useOnApp('capability.changed', (event) => {
    const payload = event as { id?: unknown; install?: unknown };
    if (typeof payload.id !== 'string') return;
    broadcaster.onGlobalEvent('event.capability.changed', {
      capability_id: payload.id,
      install: payload.install,
      agentId: 'main',
    });
  });

  wss.on('connection', (socket, request) => {
    const connection = new WsV1Connection({
      socket,
      broadcaster,
      remoteAddress: request.socket.remoteAddress ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
    });
    connections.set(connection.id, connection);
    const unregisterConnection = options.registry.add({
      id: connection.id,
      connectedAt: connection.connectedAt,
      protocol: 'kap-v1',
      remoteAddress: connection.remoteAddress ?? undefined,
      userAgent: connection.userAgent ?? undefined,
      subscriptions: () => connection.subscriptionSessionIds,
      agents: () => connection.transcriptGradesBySession(),
      hasClientHello: () => connection.hasClientHello,
    });
    socket.on('close', () => {
      unregisterConnection();
      connections.delete(connection.id);
    });
  });

  const unregister = http.upgrade((request, socket, head) => {
    if (request.url?.split('?')[0] !== path) return false;
    wss.handleUpgrade(request, socket, head, (accepted) => {
      wss.emit('connection', accepted, request);
    });
    return true;
  });

  useCleanup(() => {
    unregister();
    for (const connection of connections.values()) {
      connection.close();
    }
    connections.clear();
    broadcaster.close();
    wss.close();
  });
}

function workspaceWireOf(event: unknown): Record<string, unknown> | undefined {
  const workspace = (event as { workspace?: unknown }).workspace;
  if (typeof workspace !== 'object' || workspace === null) return undefined;
  const entry = workspace as { id?: unknown; root?: unknown; name?: unknown; lastOpenedAt?: unknown };
  if (typeof entry.id !== 'string' || typeof entry.root !== 'string') return undefined;
  return {
    workspace: {
      id: entry.id,
      root: entry.root,
      name: typeof entry.name === 'string' ? entry.name : '',
      last_opened_at:
        typeof entry.lastOpenedAt === 'number' ? new Date(entry.lastOpenedAt).toISOString() : undefined,
    },
    agentId: 'main',
  };
}
