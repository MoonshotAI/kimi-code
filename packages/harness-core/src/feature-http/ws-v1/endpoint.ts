import { useApp } from '@moonshot-ai/agent-core/app/index';
import { useCleanup, useCollection, useExpose, useInject, useOn } from '@moonshot-ai/agent-core/kernel/index';

import { WebSocketServer } from 'ws';

import { ConfigRef } from '#/features/config/index';
import { MediaLibraryRef } from '#/features/media/index';
import { parseMediaRefUrl } from '#/features/media/ref';
import { CatalogModels } from '#/features/provider-catalog/index';

import { sessionFacade, useRootUnit } from '../scope';
import type { Http } from '../server';
import type { WsRegistryStore } from '../ws-registry';

import { WsV1Connection } from './connection';
import { selectBearerProtocol } from './protocol';
import { SessionBroadcaster, WsV1BroadcasterRef } from './sessionState';

const DEFAULT_MAX_BUFFER_SIZE = 1000;

export interface WsV1EndpointOptions {
  readonly http: Http;
  readonly prefix: string;
  readonly registry: WsRegistryStore;
  readonly heartbeatIntervalMs?: number;
}

export function useWsV1Endpoint(options: WsV1EndpointOptions): void {
  const app = useApp();
  const http = options.http;
  const root = useRootUnit();
  const bindings = useCollection(CatalogModels);
  const config = useInject(ConfigRef);
  const path = `${options.prefix.replace(/\/+$/, '')}/ws`;
  const inlineMediaRef = async (sessionId: string, url: string): Promise<string | undefined> => {
    const ref = parseMediaRefUrl(url);
    if (ref === undefined) return undefined;
    const mediaLibrary = sessionFacade(root, MediaLibraryRef, sessionId);
    if (mediaLibrary === undefined) return undefined;
    const file = await mediaLibrary.open(ref);
    if (file === undefined) return undefined;
    const chunks: Uint8Array[] = [];
    for await (const chunk of file.stream()) chunks.push(chunk);
    const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return `data:${file.mediaType};base64,${Buffer.from(bytes).toString('base64')}`;
  };
  const broadcaster = new SessionBroadcaster({
    app,
    root,
    bindings: () => bindings.value,
    config: () => config.value,
    maxBufferSize: DEFAULT_MAX_BUFFER_SIZE,
    inlineMediaRef,
  });
  useExpose(WsV1BroadcasterRef, broadcaster);
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => selectBearerProtocol(protocols),
  });
  const connections = new Map<string, WsV1Connection>();

  useOn('*', (event) => {
    broadcaster.onAppEvent(event);
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
