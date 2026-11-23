
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import {
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentTaskOutputService,
  IAgentToolExecutorService,
  IConfigService,
  MAIN_AGENT_ID,
  getLiveSessionById,
  resumeSessionById,
} from '@moonshot-ai/agent-core-v2';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders, bearerToken } from './helpers/auth';


function sseLines(...events: readonly string[]): string {
  return events.map((event) => `data: ${event}\n\n`).join('') + 'data: [DONE]\n\n';
}

function sseText(text: string): string {
  return sseLines(
    JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'mock',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    }),
    JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'mock',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    }),
  );
}

function sseToolCall(id: string, name: string, args: string): string {
  return sseLines(
    JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'mock',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }],
          },
          finish_reason: null,
        },
      ],
    }),
    JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'mock',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
    }),
  );
}

interface LlmRoute {
  readonly match: (body: string) => boolean;
  readonly respond: () => string;
}

interface MockLlm {
  readonly port: number;
  readonly close: () => Promise<void>;
}

async function startMockLlm(routes: readonly LlmRoute[], fallback: () => string = () => sseText('ok')): Promise<MockLlm> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const respond = routes.find((r) => r.match(body))?.respond ?? fallback;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(respond());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'object' === false) throw new Error('no llm port');
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}


function configToml(llmPort: number): string {
  return [
    'default_model = "stub"',
    '',
    '[providers.stub]',
    'type = "openai"',
    `base_url = "http://127.0.0.1:${String(llmPort)}"`,
    'api_key = "stub"',
    '',
    '[models.stub]',
    'provider = "stub"',
    'model = "stub"',
    'max_context_size = 100000',
    '',
  ].join('\n');
}

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
}

async function rest<T>(server: RunningServer, base: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: init?.method ?? 'GET',
    headers: authHeaders(server, init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const envelope = (await res.json()) as Envelope<T> & { data: T };
  if (envelope.code !== 0) throw new Error(`REST ${path} failed: ${JSON.stringify(envelope).slice(0, 300)}`);
  return envelope.data;
}

interface TurnsPage {
  turns: any[];
  has_more: boolean;
}

const getTurns = (server: RunningServer, base: string, sid: string, agentId = MAIN_AGENT_ID): Promise<TurnsPage> =>
  rest<TurnsPage>(server, base, `/api/v1/sessions/${encodeURIComponent(sid)}/agents/${agentId}/turns`);

const textOf = (item: any): string => String(item.text ?? '');

const toolItems = (page: TurnsPage, name?: string): any[] =>
  page.turns.flatMap((turn) => turn.items).filter((item: any) => item.type === 'tool_call' && (name === undefined || item.name === name));

const getSessionFacts = async (server: RunningServer, base: string, sid: string): Promise<{ busy: boolean; pending_interaction?: string }> => {
  const session = await rest<{ activity: 'idle' | 'turn' | 'background'; pending_interaction?: string }>(
    server,
    base,
    `/api/v1/sessions/${encodeURIComponent(sid)}`,
  );
  return { busy: session.activity !== 'idle', pending_interaction: session.pending_interaction };
};

async function createSession(server: RunningServer, base: string): Promise<string> {
  const data = await rest<{ id: string }>(server, base, '/api/v1/sessions', {
    method: 'POST',
    body: { metadata: { cwd: '/tmp' } },
  });
  return data.id;
}

function submitPrompt(server: RunningServer, base: string, sid: string, text: string, permissionMode: 'manual' | 'yolo' | 'auto' = 'yolo'): Promise<{ prompt_id: string }> {
  return rest<{ prompt_id: string }>(server, base, `/api/v1/sessions/${encodeURIComponent(sid)}/prompts`, {
    method: 'POST',
    body: { content: [{ type: 'text', text }], model: 'stub', permission_mode: permissionMode },
  });
}

async function until(label: string, fn: () => Promise<boolean> | boolean, timeoutMs = 30000, intervalMs = 150): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

interface FrameSocket {
  send(frame: unknown): void;
  next(match: (frame: any) => boolean): Promise<any>;
  close(): Promise<void>;
}

async function openFrameSocket(server: RunningServer): Promise<FrameSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/ws`, [`kimi-code.bearer.${bearerToken(server)}`]);
  const frames: any[] = [];
  ws.on('message', (data) => {
    try {
      frames.push(JSON.parse(rawToString(data)));
    } catch {
    }
  });
  const closed = new Promise<void>((resolve) => {
    ws.once('close', () => resolve());
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      resolve();
    });
    ws.once('error', reject);
  });
  return {
    send: (frame) => ws.send(JSON.stringify(frame)),
    next: async (match) => {
      let found: any;
      await until('ws frame', () => {
        const index = frames.findIndex(match);
        if (index < 0) return false;
        found = frames.splice(index, 1)[0];
        return true;
      }, 10000, 20);
      return found;
    },
    close: async () => {
      ws.close();
      await closed;
    },
  };
}


describe('conversation contract e2e', () => {
  let home: string | undefined;
  let server: RunningServer | undefined;
  let llm: MockLlm | undefined;
  let base: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-conversation-contract-'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await llm?.close();
    llm = undefined;
  });

  afterAll(async () => {
    await server?.close();
    server = undefined;
    if (home !== undefined) await rm(home, { recursive: true, force: true });
    home = undefined;
  }, 30000);

  async function boot(routes: readonly LlmRoute[]): Promise<void> {
    llm = await startMockLlm(routes);
    await writeFile(join(home!, 'config.toml'), configToml(llm.port), 'utf-8');
    await server!.core.accessor.get(IConfigService).reload();
  }

  const idle = (server: RunningServer, base: string, sid: string) =>
    until('session idle', async () => !(await getSessionFacts(server, base, sid)).busy);

  it('S9: task.watch streams a running task output and resumes from since_offset', async () => {
    const sid = await createSession(server!, base);
    const agents = getLiveSessionById(server!.core.accessor, sid)!.accessor.get(IAgentLifecycleService);
    if (agents.handleOf(MAIN_AGENT_ID) === undefined) await agents.create({ agentId: MAIN_AGENT_ID });
    const main = agents.handleOf(MAIN_AGENT_ID)!;
    main.accessor.get(IAgentPermissionModeService).setMode('yolo');
    const handler = main.accessor.get(IAgentToolExecutorService).executor.execute({
      type: 'function',
      id: 'call_s9_watch',
      name: 'Bash',
      arguments: JSON.stringify({ command: "printf '  VITE ready\\n'", description: 'npm run dev', run_in_background: true }),
    }, { origin: 'loop', turnId: 0 });
    await handler;
    await until('background output', () => handler.output().preview.includes('VITE ready'));
    const taskId = handler.taskId;
    const sink = main.accessor.get(IAgentTaskOutputService).open(taskId);
    const isOutput = (frame: any): boolean => frame.type === 'task.output';

    const first = await openFrameSocket(server!);
    first.send({ type: 'task.watch', request_id: 'r1', session_id: sid, agent_id: MAIN_AGENT_ID, task_id: taskId });
    expect(await first.next((f) => f.type === 'response')).toMatchObject({ request_id: 'r1', code: 0 });
    expect(await first.next(isOutput)).toMatchObject({
      agent_id: MAIN_AGENT_ID,
      task_id: taskId,
      offset: 0,
      text: '  VITE ready\n',
    });
    sink.append('  ➜  Local: http://localhost:5173/\n');
    expect(await first.next(isOutput)).toMatchObject({ offset: 13, text: '  ➜  Local: http://localhost:5173/\n' });
    await first.close();

    sink.append('4:42:10 PM [vite] hmr update /src/App.vue\n');
    const since = 13 + Buffer.byteLength('  ➜  Local: http://localhost:5173/\n', 'utf-8');
    const second = await openFrameSocket(server!);
    second.send({
      type: 'task.watch',
      request_id: 'r2',
      session_id: sid,
      agent_id: MAIN_AGENT_ID,
      task_id: taskId,
      since_offset: since,
    });
    expect(await second.next((f) => f.type === 'response')).toMatchObject({ request_id: 'r2', code: 0 });
    expect(await second.next(isOutput)).toMatchObject({
      offset: since,
      text: '4:42:10 PM [vite] hmr update /src/App.vue\n',
    });
    second.send({ type: 'task.watch', request_id: 'r3', session_id: sid, agent_id: MAIN_AGENT_ID, task_id: 'bash-00000000' });
    expect(await second.next((f) => f.type === 'response')).toMatchObject({ request_id: 'r3', code: 40406 });

    const child = await agents.create({ agentId: 'agent-s9-child' });
    const childHandle = agents.handleOf(child.agentId)!;
    childHandle.accessor.get(IAgentPermissionModeService).setMode('yolo');
    const childHandler = childHandle.accessor.get(IAgentToolExecutorService).executor.execute({
      type: 'function',
      id: 'call_s9_child_watch',
      name: 'Bash',
      arguments: JSON.stringify({ command: "printf ' RUN  v3.2.4\\n'", description: 'pnpm test --watch', run_in_background: true }),
    }, { origin: 'loop', turnId: 0 });
    await childHandler;
    await until('child output', () => childHandler.output().preview.includes('RUN  v3.2.4'));
    const childTaskId = childHandler.taskId;
    second.send({ type: 'task.watch', request_id: 'r4', session_id: sid, agent_id: MAIN_AGENT_ID, task_id: childTaskId });
    expect(await second.next((f) => f.type === 'response')).toMatchObject({ request_id: 'r4', code: 40406 });
    second.send({ type: 'task.watch', request_id: 'r5', session_id: sid, agent_id: child.agentId, task_id: childTaskId });
    expect(await second.next((f) => f.type === 'response')).toMatchObject({ request_id: 'r5', code: 0 });
    expect(await second.next(isOutput)).toMatchObject({
      agent_id: child.agentId,
      task_id: childTaskId,
      offset: 0,
      text: ' RUN  v3.2.4\n',
    });
    await second.close();
  });

  it('S7: a foreground subagent resumes with its prior context after a server restart', async () => {
    let childAgentId: string | undefined;
    let resumedChildRequest: string | undefined;
    await boot([
      {
        match: (body) => body.includes('spawn-child') && !body.includes('"role":"tool"'),
        respond: () =>
          sseToolCall(
            'call_spawn',
            'Agent',
            JSON.stringify({ prompt: 'remember the token quartz-7731 and reply with ok', description: 'child' }),
          ),
      },
      {
        match: (body) =>
          body.includes('remember the token') && !body.includes('spawn-child') && !body.includes('recall the token'),
        respond: () => sseText('ok, remembered'),
      },
      {
        match: (body) => body.includes('resume-child') && !body.includes('recall the token'),
        respond: () =>
          sseToolCall(
            'call_resume',
            'Agent',
            JSON.stringify({ prompt: 'recall the token', description: 'child again', resume: childAgentId }),
          ),
      },
      {
        match: (body) => {
          const hit = body.includes('recall the token') && !body.includes('resume-child');
          if (hit) resumedChildRequest = body;
          return hit;
        },
        respond: () => sseText('the token is quartz-7731'),
      },
      { match: () => true, respond: () => sseText('noted') },
    ]);
    const sid = await createSession(server!, base);
    await submitPrompt(server!, base, sid, 'spawn-child now');
    await idle(server!, base, sid);

    const liveBefore = getLiveSessionById(server!.core.accessor, sid);
    expect(liveBefore).toBeDefined();
    const childIds = liveBefore!.accessor
      .get(IAgentLifecycleService)
      .list()
      .map((agent) => agent.agentId)
      .filter((id) => id !== MAIN_AGENT_ID);
    expect(childIds).toHaveLength(1);
    childAgentId = childIds[0];

    await server!.close();
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home!, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;

    const resumed = await resumeSessionById(server.core.accessor, sid);
    expect(resumed).toBeDefined();
    const agents = resumed!.accessor.get(IAgentLifecycleService);
    expect(agents.handleOf(childAgentId!)).toBeUndefined();

    await submitPrompt(server, base, sid, 'resume-child now');
    await idle(server, base, sid);

    expect(resumedChildRequest).toBeDefined();
    expect(resumedChildRequest).toContain('quartz-7731');
    expect(resumedChildRequest).toContain('ok, remembered');
    expect(agents.handleOf(childAgentId!)).toBeDefined();

    const end = await getTurns(server, base, sid);
    const agentTools = toolItems(end, 'Agent');
    expect(agentTools).toHaveLength(2);
    expect(String(agentTools[1].output)).toContain(`agent_id: ${childAgentId}`);
    expect(String(agentTools[1].output)).toContain('the token is quartz-7731');
    const child = await getTurns(server, base, sid, childAgentId);
    expect(child.turns.map((turn) => textOf(turn.items[0]))).toEqual([
      'remember the token quartz-7731 and reply with ok',
      'recall the token',
    ]);
  }, 60000);
}, 90000);
