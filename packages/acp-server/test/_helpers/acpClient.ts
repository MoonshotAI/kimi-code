import { PassThrough, Readable, Writable } from 'node:stream';

import { ndJsonStream } from '@agentclientprotocol/sdk';

import { runAcpServerWithStream, type RunningAcpServer, type RunAcpServerOptions } from '../../src/start';

interface RpcMessage {
  readonly id?: number;
  readonly method?: string;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly params?: unknown;
}

/** Handler for an agent-initiated JSON-RPC request (reverse-RPC). */
export type RequestHandler = (params: unknown) => unknown | Promise<unknown>;

export interface TestClient {
  /** Send a JSON-RPC request and resolve with the `result` (rejects on `error`). */
  send(method: string, params?: unknown): Promise<unknown>;
  /** All messages received from the agent so far (responses + notifications + requests). */
  readonly received: readonly RpcMessage[];
  /** `session/update` notifications received so far. */
  sessionUpdates(): readonly RpcMessage[];
  /** Resolve once a `session/update` whose `update.sessionUpdate` matches arrives. */
  waitForSessionUpdate(sessionUpdate: string, timeoutMs?: number): Promise<RpcMessage>;
  /**
   * Register a handler for an agent-initiated request method (e.g.
   * `session/request_permission`). The handler's return value is sent back as
   * the JSON-RPC `result`; a thrown error is sent as a JSON-RPC `error`.
   */
  onRequest(method: string, handler: RequestHandler): void;
  readonly server: RunningAcpServer;
  close(): Promise<void>;
}

/**
 * Build an in-memory ACP client/server pair for tests. The server boots a real
 * `agent-core-v2` rooted at `homeDir`; the client speaks raw ND-JSON JSON-RPC
 * over a `PassThrough` stream pair.
 */
export async function createTestClient(opts: {
  homeDir: string;
  disableAuth?: boolean;
  extraSeeds?: RunAcpServerOptions['extraSeeds'];
}): Promise<TestClient> {
  const toAgent = new PassThrough();
  const toClient = new PassThrough();
  const stream = ndJsonStream(Writable.toWeb(toClient), Readable.toWeb(toAgent));
  const server = await runAcpServerWithStream(stream, {
    homeDir: opts.homeDir,
    disableAuth: opts.disableAuth ?? true,
    extraSeeds: opts.extraSeeds,
  });

  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();
  const requestHandlers = new Map<string, RequestHandler>();
  const received: RpcMessage[] = [];
  const waiters: Array<{
    sessionUpdate: string;
    resolve: (msg: RpcMessage) => void;
    reject: (error: Error) => void;
  }> = [];
  let buffer = '';

  async function handleIncomingRequest(
    id: number,
    method: string,
    params: unknown,
  ): Promise<void> {
    const handler = requestHandlers.get(method);
    try {
      if (handler === undefined) {
        throw new Error(`TestClient: no handler registered for agent request '${method}'`);
      }
      const result = await handler(params);
      toAgent.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toAgent.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message } })}\n`,
      );
    }
  }

  function dispatch(msg: RpcMessage): void {
    received.push(msg);
    // Incoming request from the agent (reverse-RPC): has both id and method.
    if (msg.id !== undefined && msg.method !== undefined) {
      void handleIncomingRequest(msg.id, msg.method, msg.params);
      return;
    }
    // Notification (no id): check session/update waiters first.
    if (msg.id === undefined && msg.method === 'session/update') {
      const update = (msg.params as { update?: { sessionUpdate?: string } } | undefined)?.update;
      const kind = update?.sessionUpdate;
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.sessionUpdate === kind) {
          const [w] = waiters.splice(i, 1);
          w!.resolve(msg);
        }
      }
      return;
    }
    // Response: resolve the pending request by id.
    if (msg.id !== undefined && pending.has(msg.id)) {
      const entry = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error !== undefined) entry.reject(new Error(JSON.stringify(msg.error)));
      else entry.resolve(msg.result);
    }
  }

  const reader = (async (): Promise<void> => {
    for await (const chunk of toClient) {
      buffer += (chunk as Buffer).toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim().length === 0) continue;
        dispatch(JSON.parse(line) as RpcMessage);
      }
    }
  })();

  function send(method: string, params?: unknown): Promise<unknown> {
    const id = nextId++;
    const request = { jsonrpc: '2.0', id, method, params: params ?? {} };
    toAgent.write(`${JSON.stringify(request)}\n`);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  }

  function sessionUpdates(): readonly RpcMessage[] {
    return received.filter((m) => m.method === 'session/update');
  }

  function waitForSessionUpdate(sessionUpdate: string, timeoutMs = 5_000): Promise<RpcMessage> {
    const existing = sessionUpdates().find((m) => {
      const update = (m.params as { update?: { sessionUpdate?: string } } | undefined)?.update;
      return update?.sessionUpdate === sessionUpdate;
    });
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { sessionUpdate, resolve, reject };
      waiters.push(waiter);
      setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i >= 0) {
          waiters.splice(i, 1);
          reject(new Error(`timed out waiting for session/update '${sessionUpdate}'`));
        }
      }, timeoutMs);
    });
  }

  async function close(): Promise<void> {
    await server.close();
    toAgent.end();
    toClient.end();
    await reader;
  }

  function onRequest(method: string, handler: RequestHandler): void {
    requestHandlers.set(method, handler);
  }

  return { send, received, sessionUpdates, waitForSessionUpdate, onRequest, server, close };
}
