import { randomUUID } from 'node:crypto';

import { useApp } from '@moonshot-ai/agent-core/app/index';
import { useCleanup, useOn } from '@moonshot-ai/agent-core/kernel/index';
import type { Agent } from '@moonshot-ai/agent-core/session/index';

import { WebSocket, WebSocketServer, type RawData } from 'ws';

import type { Http } from './server';
import { ErrorCode } from './route/http';
import type { WsRegistryStore } from './ws-registry';

const WS_PING_INTERVAL_MS = 30_000;

const WS_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent.registered',
  'agent.opened',
  'agent.closed',
  'interaction.requested',
  'interaction.resolved',
  'message.appended',
  'turn.started',
  'turn.ended',
  'todo.updated',
  'session.created',
  'session.meta_updated',
  'compaction.started',
  'compaction.completed',
  'compaction.cancelled',
  'compaction.blocked',
]);

type AgentGrade = 'turn' | 'delta';

const AGENT_GRADE_EVENT_TYPES: Record<AgentGrade, readonly string[]> = {
  turn: [
    'turn.started',
    'turn.ended',
    'step.started',
    'tool.started',
    'tool.delta',
    'tool.ended',
    'tool.async_ended',
  ],
  delta: [
    'turn.started',
    'turn.ended',
    'step.started',
    'tool.started',
    'tool.delta',
    'tool.ended',
    'tool.async_ended',
    'llm.streaming.part',
  ],
};

interface AgentSubscription {
  grade: AgentGrade;
  offs: Array<() => void>;
}

interface SessionSubscription {
  agents: Map<string, AgentSubscription>;
}

interface Connection {
  readonly id: string;
  readonly connectedAt: string;
  readonly socket: WebSocket;
  readonly sessions: Map<string, SessionSubscription>;
  readonly ping: ReturnType<typeof setInterval>;
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

export function useWsEndpoint(options: { http: Http; prefix: string; registry: WsRegistryStore }): void {
  const app = useApp();
  const http = options.http;
  const path = `${options.prefix.replace(/\/+$/, '')}/ws`;
  const wss = new WebSocketServer({ noServer: true });
  const connections = new Map<string, Connection>();

  const send = (socket: WebSocket, frame: Record<string, unknown>): void => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(frame));
  };

  const sendError = (socket: WebSocket, code: number, msg: string): void => {
    send(socket, { type: 'error', code, msg });
  };

  useOn('*', (event) => {
    if (event.type === 'session.deleted') {
      const sessionId = event['sessionId'];
      if (typeof sessionId !== 'string') return;
      for (const connection of connections.values()) {
        send(connection.socket, {
          type: 'event',
          session_id: sessionId,
          agent_id: undefined,
          event_type: 'session.deleted',
          payload: Object.fromEntries(
            Object.entries(event).filter(
              ([key]) => key !== 'type' && key !== 'sessionId' && key !== 'agentId',
            ),
          ),
        });
      }
      return;
    }
    if (!WS_EVENT_TYPES.has(event.type)) return;
    const sessionId = event['sessionId'];
    if (typeof sessionId !== 'string') return;
    const agentId = event['agentId'];
    for (const connection of connections.values()) {
      const entry = connection.sessions.get(sessionId);
      if (entry === undefined) continue;
      if (
        event.type === 'turn.started' &&
        typeof agentId === 'string' &&
        entry.agents.has(agentId)
      ) {
        continue;
      }
      send(connection.socket, {
        type: 'event',
        session_id: sessionId,
        agent_id: typeof agentId === 'string' ? agentId : undefined,
        event_type: event.type,
        payload: Object.fromEntries(
          Object.entries(event).filter(
            ([key]) => key !== 'type' && key !== 'sessionId' && key !== 'agentId',
          ),
        ),
      });
    }
  });

  const drop = (connection: Connection): void => {
    if (!connections.delete(connection.id)) return;
    clearInterval(connection.ping);
    for (const session of connection.sessions.values()) {
      detachAgents(session);
    }
    connection.sessions.clear();
  };

  const detachAgents = (session: SessionSubscription): void => {
    for (const agent of session.agents.values()) {
      for (const off of agent.offs) off();
    }
    session.agents.clear();
  };

  const subscribe = (connection: Connection, sessionId: string, agents: Record<string, AgentGrade>): void => {
    const session = app.sessions.get(sessionId);
    if (session === undefined) {
      sendError(connection.socket, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
      return;
    }
    const handles = new Map<string, Agent>();
    for (const agentId of Object.keys(agents)) {
      const handle = session.agents.get(agentId);
      if (handle === undefined) {
        sendError(connection.socket, ErrorCode.VALIDATION_FAILED, `unknown agent ${agentId}`);
        return;
      }
      handles.set(agentId, handle);
    }
    let entry = connection.sessions.get(sessionId);
    if (entry === undefined) {
      entry = { agents: new Map() };
      connection.sessions.set(sessionId, entry);
    }
    detachAgents(entry);
    for (const [agentId, handle] of handles) {
      const grade = agents[agentId] as AgentGrade;
      const offs = AGENT_GRADE_EVENT_TYPES[grade].map((type) =>
        handle.loop.subscribe((event) => {
          if (event.type !== type) return;
          send(connection.socket, {
            type: 'event',
            session_id: sessionId,
            agent_id: agentId,
            event_type: event.type,
            payload: Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'type')),
          });
        }),
      );
      entry.agents.set(agentId, { grade, offs });
    }
    send(connection.socket, { type: 'subscribed', session_id: sessionId });
  };

  const unsubscribe = (connection: Connection, sessionId: string): void => {
    const entry = connection.sessions.get(sessionId);
    if (entry !== undefined) {
      connection.sessions.delete(sessionId);
      detachAgents(entry);
    }
    send(connection.socket, { type: 'unsubscribed', session_id: sessionId });
  };

  const onMessage = (connection: Connection, data: RawData): void => {
    let frame: unknown;
    try {
      frame = JSON.parse(rawDataToString(data));
    } catch {
      sendError(connection.socket, ErrorCode.VALIDATION_FAILED, 'invalid JSON frame');
      return;
    }
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
      sendError(connection.socket, ErrorCode.VALIDATION_FAILED, 'invalid frame');
      return;
    }
    const type = (frame as { type?: unknown })['type'];
    const sessionId = (frame as { session_id?: unknown })['session_id'];
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      sendError(connection.socket, ErrorCode.VALIDATION_FAILED, 'session_id is required');
      return;
    }
    if (type === 'subscribe') {
      const rawAgents = (frame as { agents?: unknown })['agents'];
      const agents: Record<string, AgentGrade> = {};
      if (rawAgents !== undefined) {
        if (rawAgents === null || typeof rawAgents !== 'object' || Array.isArray(rawAgents)) {
          sendError(connection.socket, ErrorCode.VALIDATION_FAILED, 'agents must be an object');
          return;
        }
        for (const [agentId, grade] of Object.entries(rawAgents)) {
          if (grade !== 'turn' && grade !== 'delta') {
            sendError(connection.socket, ErrorCode.VALIDATION_FAILED, `unknown agent grade for ${agentId}`);
            return;
          }
          agents[agentId] = grade;
        }
      }
      subscribe(connection, sessionId, agents);
      return;
    }
    if (type === 'unsubscribe') {
      unsubscribe(connection, sessionId);
      return;
    }
    sendError(connection.socket, ErrorCode.VALIDATION_FAILED, 'unknown frame type');
  };

  wss.on('connection', (socket) => {
    const connection: Connection = {
      id: randomUUID(),
      connectedAt: new Date().toISOString(),
      socket,
      sessions: new Map(),
      ping: setInterval(() => {
        send(socket, { type: 'ping', ts: Date.now() });
      }, WS_PING_INTERVAL_MS),
    };
    connection.ping.unref();
    connections.set(connection.id, connection);
    const unregisterConnection = options.registry.add({
      id: connection.id,
      connectedAt: connection.connectedAt,
      protocol: 'native',
      subscriptions: () => [...connection.sessions.keys()],
      agents: () =>
        Object.fromEntries(
          [...connection.sessions.entries()].map(([sessionId, session]) => [
            sessionId,
            Object.fromEntries([...session.agents.entries()].map(([agentId, agent]) => [agentId, agent.grade])),
          ]),
        ),
    });
    socket.on('message', (data: RawData) => {
      onMessage(connection, data);
    });
    socket.on('error', () => {
      socket.terminate();
    });
    socket.on('close', () => {
      unregisterConnection();
      drop(connection);
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
      clearInterval(connection.ping);
      for (const session of connection.sessions.values()) {
        detachAgents(session);
      }
      connection.sessions.clear();
      connection.socket.terminate();
    }
    connections.clear();
    wss.close();
  });
}
