import { once } from 'node:events';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import {
  createKimiHarness,
  createKimiHarnessV2,
  type Event,
  type KimiHarness,
  type Session,
} from '@moonshot-ai/kimi-code-sdk';

import { runAcpServerWithStream } from '../../src/server';

const TEST_IDENTITY = {
  userAgentProduct: 'kimi-code-cli',
  version: '0.0.0-test',
} as const;
const API_KEY = 'YOUR_API_KEY';
const MODEL = 'stub-model';
const WAIT_TIMEOUT_MS = 15_000;

export type Engine = 'v1' | 'v2';

export type ModelReply =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'tool';
      readonly id: string;
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    };

export interface ModelRequest {
  readonly authorization: string | undefined;
  readonly body: Readonly<Record<string, unknown>>;
}

class LoopbackModelServer {
  readonly requests: ModelRequest[] = [];
  readonly baseUrl: string;

  private constructor(
    private readonly server: Server,
    private readonly replies: readonly ModelReply[],
    port: number,
  ) {
    this.baseUrl = `http://127.0.0.1:${String(port)}/v1`;
  }

  static async start(replies: readonly ModelReply[]): Promise<LoopbackModelServer> {
    let fixture: LoopbackModelServer | undefined;
    const server = createServer((request, response) => {
      void fixture?.handle(request, response);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    fixture = new LoopbackModelServer(server, replies, address.port);
    return fixture;
  }

  async close(): Promise<void> {
    const closed = once(this.server, 'close');
    this.server.closeAllConnections();
    this.server.close();
    await closed;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'GET' && request.url === '/v1/models') {
      respondJson(response, 200, {
        object: 'list',
        data: [{ id: MODEL, object: 'model', owned_by: 'example' }],
      });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      request.resume();
      respondJson(response, 404, { error: { message: 'unknown test endpoint' } });
      return;
    }

    const authorization = headerValue(request.headers.authorization);
    if (authorization !== `Bearer ${API_KEY}`) {
      request.resume();
      respondJson(response, 401, { error: { message: 'invalid test authorization' } });
      return;
    }

    try {
      const body = await readJsonBody(request);
      const reply = this.replies[this.requests.length];
      this.requests.push({ authorization, body });
      if (reply === undefined) {
        respondJson(response, 500, { error: { message: 'unexpected model request' } });
        return;
      }
      respondSse(response, reply, this.requests.length);
    } catch (error) {
      respondJson(response, 400, {
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}

export class CollectingClient implements Client {
  readonly updates: SessionNotification[] = [];
  private readonly waiters = new Set<{
    readonly predicate: (notification: SessionNotification) => boolean;
    readonly resolve: (notification: SessionNotification) => void;
    readonly reject: (error: Error) => void;
    readonly signal: AbortSignal;
    readonly onAbort: () => void;
  }>();

  async requestPermission(_request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('requestPermission should not be called in the real-engine ACP rig');
  }

  async sessionUpdate(notification: SessionNotification): Promise<void> {
    this.updates.push(notification);
    for (const waiter of this.waiters) {
      if (!waiter.predicate(notification)) continue;
      this.waiters.delete(waiter);
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.resolve(notification);
    }
  }

  async writeTextFile(request: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    await writeFile(request.path, request.content, 'utf-8');
    return {};
  }

  async readTextFile(request: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    return { content: await readFile(request.path, 'utf-8') };
  }

  waitForUpdate(
    predicate: (notification: SessionNotification) => boolean,
    label: string,
  ): Promise<SessionNotification> {
    const existing = this.updates.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const signal = AbortSignal.timeout(WAIT_TIMEOUT_MS);
      const waiter = {
        predicate,
        resolve,
        reject,
        signal,
        onAbort: () => {
          this.waiters.delete(waiter);
          reject(
            new Error(
              `Timed out waiting for ACP update "${label}". Updates: ${JSON.stringify(this.updates)}`,
            ),
          );
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }
}

export interface RealEngineRig {
  readonly client: ClientSideConnection;
  readonly collecting: CollectingClient;
  readonly harness: KimiHarness;
  readonly modelRequests: readonly ModelRequest[];
  readonly session: Session;
  readonly workDir: string;
  close(): Promise<void>;
}

export async function createRealEngineRig(options: {
  readonly engine: Engine;
  readonly homeDir: string;
  readonly workDir: string;
  readonly replies: readonly ModelReply[];
  readonly additionalConfig?: string;
}): Promise<RealEngineRig> {
  const modelServer = await LoopbackModelServer.start(options.replies);
  let harness: KimiHarness | undefined;
  let clientToAgent: TransformStream<Uint8Array, Uint8Array> | undefined;
  let agentToClient: TransformStream<Uint8Array, Uint8Array> | undefined;
  let client: ClientSideConnection | undefined;
  let serverRun: Promise<void> | undefined;
  const cleanup = () =>
    runCleanupSteps([
      () => clientToAgent?.writable.close(),
      () => serverRun,
      () => agentToClient?.writable.close(),
      () => client?.closed,
      () => harness?.close(),
      () => modelServer.close(),
      () => rm(options.homeDir, { recursive: true, force: true }),
      () => rm(options.workDir, { recursive: true, force: true }),
    ]);
  try {
    await writeFile(
      `${options.homeDir}/config.toml`,
      modelConfig(modelServer.baseUrl, options.additionalConfig),
      'utf-8',
    );
    const harnessFactory = options.engine === 'v1' ? createKimiHarness : createKimiHarnessV2;
    harness = harnessFactory({ homeDir: options.homeDir, identity: TEST_IDENTITY });

    clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    const agentStream = ndJsonStream(agentToClient.writable, clientToAgent.readable);
    const clientStream = ndJsonStream(clientToAgent.writable, agentToClient.readable);
    serverRun = runAcpServerWithStream(harness, agentStream);
    const collecting = new CollectingClient();
    client = new ClientSideConnection(() => collecting, clientStream);
    const response = await client.newSession({ cwd: options.workDir, mcpServers: [] });
    const session = harness.getSession(response.sessionId);
    if (session === undefined) {
      throw new Error(`Harness did not retain ACP session ${response.sessionId}`);
    }

    let closePromise: Promise<void> | undefined;
    return {
      client,
      collecting,
      harness,
      modelRequests: modelServer.requests,
      session,
      workDir: options.workDir,
      close() {
        closePromise ??= cleanup();
        return closePromise;
      },
    };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}

async function runCleanupSteps(
  steps: readonly (() => Promise<unknown> | undefined)[],
): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Failed to close the real-engine ACP test rig');
  }
}

export function waitForSessionEvent(
  session: Session,
  predicate: (event: Event) => boolean,
  label: string,
): Promise<Event> {
  const seen: Event[] = [];
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(WAIT_TIMEOUT_MS);
    const unsubscribe = session.onEvent((event) => {
      seen.push(event);
      if (!predicate(event)) return;
      signal.removeEventListener('abort', onAbort);
      unsubscribe();
      resolve(event);
    });
    const onAbort = () => {
      unsubscribe();
      reject(
        new Error(`Timed out waiting for SDK event "${label}". Events: ${JSON.stringify(seen)}`),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function modelConfig(baseUrl: string, additionalConfig: string | undefined): string {
  return `
default_provider = "local"
default_model = "${MODEL}"
default_permission_mode = "yolo"
telemetry = false

[providers.local]
type = "kimi"
api_key = "${API_KEY}"
base_url = "${baseUrl}"

[models.${MODEL}]
provider = "local"
model = "${MODEL}"
max_context_size = 262144
${additionalConfig ?? ''}
`;
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<Readonly<Record<string, unknown>>> {
  let body = '';
  for await (const chunk of request) {
    body += chunk.toString();
  }
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('model request body must be an object');
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function respondSse(response: ServerResponse, reply: ModelReply, sequence: number): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const base = {
    id: `stub-completion-${String(sequence)}`,
    object: 'chat.completion.chunk',
    created: 1,
    model: MODEL,
  };
  if (reply.kind === 'tool') {
    writeSse(response, {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: reply.id,
                type: 'function',
                function: { name: reply.name, arguments: '' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    writeSse(response, {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: JSON.stringify(reply.arguments) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    writeSse(response, {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  } else {
    writeSse(response, {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: reply.text },
          finish_reason: null,
        },
      ],
    });
    writeSse(response, {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }
  response.end('data: [DONE]\n\n');
}

function writeSse(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function respondJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function headerValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}
