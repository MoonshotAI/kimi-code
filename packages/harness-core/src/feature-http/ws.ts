import { useApp, useCleanup, useOnApp, type AgentHandle } from '@moonshot-ai/agent-core';
import {
  type Unsubscribe,
} from '@moonshot-ai/agent-core/kernel/index';
import { randomUUID } from 'node:crypto';

import { WebSocket, WebSocketServer, type RawData } from 'ws';

import { useHttp } from './feature';
import { ErrorCode } from './route/http';
import type { WsRegistryStore } from './ws-registry';

const WS_PING_INTERVAL_MS = 30_000;

const WS_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent.created',
  'agent.opened',
  'agent.closed',
  'agent.switched',
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
]);

type AgentGrade = 'turn' | 'delta';

const AGENT_GRADE_EVENT_TYPES: Record<AgentGrade, readonly string[]> = {
  turn: [
    'turn.started',
    'turn.done',
    'turn.drained',
    'turn.spawn_tools',
    'step.started',
    'tool.update',
    'tool.done',
    'tool.detached',
  ],
  delta: [
    'turn.started',
    'turn.done',
    'turn.drained',
    'turn.spawn_tools',
    'step.started',
    'tool.update',
    'tool.done',
    'tool.detached',
    'llm.streaming.part',
  ],
};

interface AgentSubscription {
  grade: AgentGrade;
  offs: Unsubscribe[];
}

interface SessionSubscription {
  off: Unsubscribe;
  agents: Map<string, AgentSubscription>;
}

interface Connection {
  readonly id: string;
  readonly connectedAt: string;
  readonly socket: WebSocket;
  readonly sessions: Map<string, SessionSubscription>;
  readonly ping: ReturnType<typeof setInterval>;
}

export function useWsEndpoint(options: { prefix: string; registry: WsRegistryStore }): void {
  const app = useApp();
  const http = useHttp();
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

  useOnApp('session.deleted', (event) => {
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
  });

  const drop = (connection: Connection): void => {
    if (!connections.delete(connection.id)) return;
    clearInterval(connection.ping);
    for (const session of connection.sessions.values()) {
      session.off();
      for (const agent of session.agents.values()) {
        for (const off of agent.offs) off();
      }
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
    const session = app.get(sessionId);
    if (session === undefined) {
      sendError(connection.socket, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
      return;
    }
    const handles = new Map<string, AgentHandle>();
    for (const agentId of Object.keys(agents)) {
      const handle = session.get(agentId);
      if (handle === undefined) {
        sendError(connection.socket, ErrorCode.VALIDATION_FAILED, `unknown agent ${agentId}`);
        return;
      }
      handles.set(agentId, handle);
    }
    let entry = connection.sessions.get(sessionId);
    if (entry === undefined) {
      const off = session.on('*', (event) => {
        if (!WS_EVENT_TYPES.has(event.type)) return;
        const agentId = event['agentId'];
        if (
          event.type === 'turn.started' &&
          typeof agentId === 'string' &&
          connection.sessions.get(sessionId)?.agents.has(agentId) === true
        ) {
          return;
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
      });
      entry = { off, agents: new Map() };
      connection.sessions.set(sessionId, entry);
    }
    detachAgents(entry);
    for (const [agentId, handle] of handles) {
      const grade = agents[agentId] as AgentGrade;
      const offs = AGENT_GRADE_EVENT_TYPES[grade].map((type) => {
        const subscription = handle.on(type as 'turn.started', (event) => {
          send(connection.socket, {
            type: 'event',
            session_id: sessionId,
            agent_id: agentId,
            event_type: event.type,
            payload: Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'type')),
          });
        });
        return () => subscription.unsubscribe();
      });
      entry.agents.set(agentId, { grade, offs });
    }
    send(connection.socket, { type: 'subscribed', session_id: sessionId });
  };

  const unsubscribe = (connection: Connection, sessionId: string): void => {
    const entry = connection.sessions.get(sessionId);
    if (entry !== undefined) {
      connection.sessions.delete(sessionId);
      entry.off();
      detachAgents(entry);
    }
    send(connection.socket, { type: 'unsubscribed', session_id: sessionId });
  };

  const onMessage = (connection: Connection, data: RawData): void => {
    let frame: unknown;
    try {
      frame = JSON.parse(data.toString());
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
    socket.on('message', (data: RawData) => onMessage(connection, data));
    socket.on('error', () => socket.terminate());
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
    for (const connection of [...connections.values()]) {
      clearInterval(connection.ping);
      for (const session of connection.sessions.values()) {
        session.off();
        for (const agent of session.agents.values()) {
          for (const off of agent.offs) off();
        }
      }
      connection.sessions.clear();
      connection.socket.terminate();
    }
    connections.clear();
    wss.close();
  });
}
