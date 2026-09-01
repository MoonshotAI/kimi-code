
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';

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
  readonly delayMs?: number;
}

interface MockLlm {
  readonly port: number;
  readonly hits: string[];
  readonly close: () => Promise<void>;
}

async function startMockLlm(routes: readonly LlmRoute[], fallback: () => string = () => sseText('ok')): Promise<MockLlm> {
  const hits: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      hits.push(body);
      const route = routes.find((r) => r.match(body));
      const respond = route?.respond ?? fallback;
      const send = (): void => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(respond());
      };
      if (route?.delayMs !== undefined) setTimeout(send, route.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'object' === false) throw new Error('no llm port');
  return {
    port: address.port,
    hits,
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

interface TxSnapshot {
  items: any[];
  tasks: any[];
  interactions: any[];
  attachments: any[];
  todos: any[];
  prompts: { promptId: string; status: string }[];
  meta: { activity?: string; agent?: unknown; goal?: unknown; modes?: unknown };
}

const getTranscript = (server: RunningServer, base: string, sid: string): Promise<TxSnapshot> =>
  rest<TxSnapshot>(server, base, `/api/v1/sessions/${encodeURIComponent(sid)}/transcript?agent_id=main`);

const getSessionFacts = (server: RunningServer, base: string, sid: string): Promise<{ busy: boolean; pendingInteraction: string }> =>
  rest(server, base, `/api/v1/sessions/${encodeURIComponent(sid)}`);

async function createSession(server: RunningServer, base: string): Promise<string> {
  const data = await rest<{ id: string }>(server, base, '/api/v1/sessions', {
    method: 'POST',
    body: { metadata: { cwd: '/tmp' } },
  });
  return data.id;
}

function submitPrompt(server: RunningServer, base: string, sid: string, text: string, permissionMode: 'manual' | 'yolo' = 'yolo'): Promise<{ prompt_id: string }> {
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

interface TranscriptChannel {
  readonly frames: any[];
  readonly ops: any[];
  reset(): any;
  close(): void;
}

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

async function subscribeTranscript(server: RunningServer, sid: string): Promise<TranscriptChannel> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/ws`, [`kimi-code.bearer.${bearerToken(server)}`]);
  const frames: any[] = [];
  const ops: any[] = [];
  let resetFrame: any;
  ws.on('message', (data) => {
    let frame: any;
    try {
      frame = JSON.parse(rawToString(data));
    } catch {
      return;
    }
    frames.push(frame);
    const payload = frame.payload as { agent_id?: string; ops?: any[] } | undefined;
    if (frame.type === 'transcript.reset' && payload?.agent_id === 'main' && resetFrame === undefined) {
      resetFrame = frame;
    }
    if (frame.type === 'transcript.ops' && payload?.agent_id === 'main') ops.push(...(payload.ops ?? []));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      resolve();
    });
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'subscribe_v2', id: 'sub-1', payload: { session_id: sid, transcript: { '*': 'delta' } } }));
  await until('transcript.reset', () => resetFrame !== undefined, 15000);
  return {
    frames,
    ops,
    reset: () => resetFrame?.payload,
    close: () => ws.close(),
  };
}


describe('transcript contract e2e', () => {
  let home: string | undefined;
  let server: RunningServer | undefined;
  let llm: MockLlm | undefined;
  let base: string;

  afterEach(async () => {
    await llm?.close();
    await server?.close();
    if (home !== undefined) await rm(home, { recursive: true, force: true });
    home = undefined;
    server = undefined;
    llm = undefined;
  });

  async function boot(routes: readonly LlmRoute[]): Promise<void> {
    llm = await startMockLlm(routes);
    home = await mkdtemp(join(tmpdir(), 'kimi-transcript-contract-'));
    await writeFile(join(home, 'config.toml'), configToml(llm.port), 'utf-8');
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
  }

  const idle = (server: RunningServer, base: string, sid: string) =>
    until('session idle', async () => !(await getSessionFacts(server, base, sid)).busy);

  function dumpState(tx: TxSnapshot, hits: string[]): string {
    const turns = tx.items
      .filter((i) => i.kind === 'turn')
      .map((t: any) => ({
        id: t.turnId,
        state: t.state,
        origin: t.origin?.kind,
        steps: t.steps.map((s: any) => ({
          ordinal: s.ordinal,
          state: s.state,
          frames: s.frames.map((f: any) => `${f.kind}:${f.role ?? ''}:${f.name ?? ''}:${f.state ?? ''}`),
        })),
      }));
    const markers = hits
      .map((hit) => /"content":"([^"]{0,60})/.exec(hit)?.[1] ?? hit.slice(0, 60))
      .slice(0, 8);
    return `${JSON.stringify({ meta: tx.meta, prompts: tx.prompts, turns, interactions: tx.interactions })}\nllm hits (${hits.length}): ${JSON.stringify(markers)}`;
  }

  const idleOrDump = async (server: RunningServer, base: string, sid: string): Promise<void> => {
    try {
      await idle(server, base, sid);
    } catch (error) {
      const tx = await getTranscript(server, base, sid);
      throw new Error(`${(error as Error).message}\ntranscript at timeout: ${dumpState(tx, llm?.hits ?? [])}`, { cause: error });
    }
  };

  it('S1: turn lifecycle produces activity, prompts and turn frames on both channels', async () => {
    await boot([{ match: () => true, respond: () => sseText('hello world'), delayMs: 3000 }]);
    const sid = await createSession(server!, base);
    await submitPrompt(server!, base, sid, 'say hello');
    const channel = await subscribeTranscript(server!, sid);

    await until('turn running + prompt tracked', async () => {
      const tx = await getTranscript(server!, base, sid);
      return (
        tx.meta.activity === 'turn' &&
        tx.prompts.some((p) => p.status === 'running') &&
        tx.items.some((i) => i.kind === 'turn' && i.state === 'running')
      );
    });
    const mid = await getTranscript(server!, base, sid);
    expect(mid.meta.activity).toBe('turn');
    expect(mid.prompts.length).toBeGreaterThan(0);
    expect(mid.prompts[0]!.promptId.length).toBeGreaterThan(0);

    await idle(server!, base, sid);

    const end = await getTranscript(server!, base, sid);
    expect(end.meta.activity).toBe('idle');
    const turn = end.items.find((i) => i.kind === 'turn');
    expect(turn).toMatchObject({ state: 'completed' });
    expect(typeof turn.endedAt).toBe('string');
    const frameKinds = turn.steps.flatMap((s: any) => s.frames).map((f: any) => f.kind);
    expect(frameKinds).toContain('text');
    const promptStatuses = end.prompts.map((p) => p.status);
    expect(promptStatuses.every((s) => s === 'completed')).toBe(true);

    const reset = channel.reset();
    expect(reset.snapshot.meta.activity).toBe('turn');
    const opTypes = new Set(channel.ops.map((o: any) => o.op));
    expect(opTypes.has('turn.upsert')).toBe(true);
    expect(opTypes.has('step.upsert')).toBe(true);
    expect(opTypes.has('frame.upsert') || opTypes.has('append')).toBe(true);
    expect(opTypes.has('prompt.upsert')).toBe(true);
    const activityMerges = channel.ops.filter((o: any) => o.op === 'meta.merge' && o.meta?.activity !== undefined);
    expect(activityMerges.map((o: any) => o.meta.activity)).toContain('idle');
    channel.close();
  });

  it('S2: a prompt submitted mid-turn is tracked as queued through settlement', async () => {
    await boot([
      { match: (body) => body.includes('first prompt'), respond: () => sseText('first done'), delayMs: 2500 },
      { match: () => true, respond: () => sseText('second done') },
    ]);
    const sid = await createSession(server!, base);
    await submitPrompt(server!, base, sid, 'first prompt');
    await until('first prompt running', async () =>
      (await getTranscript(server!, base, sid)).prompts.some((p) => p.status === 'running'),
    );

    await submitPrompt(server!, base, sid, 'second prompt');
    await until('second prompt queued', async () => {
      const tx = await getTranscript(server!, base, sid);
      return tx.prompts.some((p) => p.status === 'queued') && tx.prompts.some((p) => p.status === 'running');
    });
    const mid = await getTranscript(server!, base, sid);
    expect(mid.prompts.map((p) => p.status).sort()).toEqual(['queued', 'running']);

    await until('both settled', async () => {
      const tx = await getTranscript(server!, base, sid);
      return tx.prompts.length > 0 && tx.prompts.every((p) => p.status === 'completed');
    }, 45000);
  });

  it('S3: a pending approval appears as an interaction with tool linkage, then resolves', async () => {
    await boot([
      { match: (body) => !body.includes('echo contract-hi'), respond: () => sseToolCall('call_1', 'Bash', '{"command":"echo contract-hi"}') },
      { match: () => true, respond: () => sseText('tool done') },
    ]);
    const sid = await createSession(server!, base);
    await submitPrompt(server!, base, sid, 'run the echo', 'manual');

    await until('approval pending', async () => {
      const tx = await getTranscript(server!, base, sid);
      return tx.interactions.some((x: any) => x.interactionKind === 'approval' && x.state === 'pending');
    });
    const mid = await getTranscript(server!, base, sid);
    const approval = mid.interactions.find((x: any) => x.interactionKind === 'approval' && x.state === 'pending');
    expect(approval).toBeDefined();
    expect(approval.toolCallId).toBe('call_1');
    expect((approval.request as any)?.toolName).toBe('Bash');
    expect(mid.meta.agent).toBeDefined();

    await rest(server!, base, `/api/v1/sessions/${encodeURIComponent(sid)}/approvals/${encodeURIComponent(approval.interactionId)}`, {
      method: 'POST',
      body: { decision: 'approved' },
    });
    await idle(server!, base, sid);

    const end = await getTranscript(server!, base, sid);
    expect(end.interactions.every((x: any) => x.state !== 'pending')).toBe(true);
    expect(end.meta.activity).toBe('idle');
    const toolFrame = end.items
      .filter((i) => i.kind === 'turn')
      .flatMap((t: any) => t.steps)
      .flatMap((s: any) => s.frames)
      .find((f: any) => f.kind === 'tool' && f.name === 'Bash');
    expect(toolFrame).toMatchObject({ state: 'done' });
    expect(String(toolFrame.output)).toContain('contract-hi');
  });

  it('S4: a background subagent produces task entities and a task-origin notification turn', async () => {
    await boot([
      {
        match: (body) => body.includes('spawn-bg') && !body.includes('"role":"tool"'),
        respond: () => sseToolCall('call_a', 'Agent', '{"prompt":"bg-answer-42","description":"bg ans","run_in_background":true}'),
      },
      { match: (body) => body.includes('bg-answer-42'), respond: () => sseText('42'), delayMs: 2500 },
      { match: () => true, respond: () => sseText('noted') },
    ]);
    const sid = await createSession(server!, base);
    await submitPrompt(server!, base, sid, 'spawn-bg one background agent');

    await until('background task running', async () => {
      const tx = await getTranscript(server!, base, sid);
      return tx.tasks.some((t: any) => t.kind === 'subagent' && t.state === 'running');
    });
    const mid = await getTranscript(server!, base, sid);
    const task = mid.tasks.find((t: any) => t.kind === 'subagent');
    expect(task).toMatchObject({ state: 'running', detached: true });
    expect(typeof task.agentId).toBe('string');

    await until('task completed', async () => {
      const tx = await getTranscript(server!, base, sid);
      return tx.tasks.some((t: any) => t.taskId === task.taskId && t.state === 'completed');
    }, 45000).catch(async (error) => {
      const tx = await getTranscript(server!, base, sid);
      const opsData = await rest<{ batches: { seq: number; ops: any[] }[] }>(
        server!,
        base,
        `/api/v1/sessions/${encodeURIComponent(sid)}/transcript/ops?agent_id=main&since_seq=0`,
      );
      const taskOps = opsData.batches.flatMap((b) =>
        b.ops
          .filter((o: any) => o.op === 'task.upsert')
          .map((o: any) => `${b.seq}:${o.task.taskId}:${o.task.state}`),
      );
      throw new Error(`${(error as Error).message}\ntasks: ${JSON.stringify(tx.tasks)}\ntaskOps: ${JSON.stringify(taskOps)}`, { cause: error });
    });
    await until('notification turn exists', async () => {
      const tx = await getTranscript(server!, base, sid);
      return tx.items.some((i: any) => i.kind === 'turn' && i.origin?.kind === 'task');
    }, 45000);

    const end = await getTranscript(server!, base, sid);
    const taskTurn = end.items.find((i: any) => i.kind === 'turn' && i.origin?.kind === 'task');
    expect(taskTurn).toBeDefined();
    expect(JSON.stringify(taskTurn)).toContain('notification');
    await idleOrDump(server!, base, sid);
    expect((await getTranscript(server!, base, sid)).meta.activity).toBe('idle');
  });

  it('S5: late attach backfills liveness and the prompt queue from the live loop', async () => {
    await boot([{ match: () => true, respond: () => sseText('slow answer'), delayMs: 4000 }]);
    const sid = await createSession(server!, base);
    await submitPrompt(server!, base, sid, 'take your time');

    const tx = await getTranscript(server!, base, sid);
    expect(tx.meta.activity).toBe('turn');
    expect(tx.items.some((i: any) => i.kind === 'turn' && i.state === 'running')).toBe(true);
    expect(tx.prompts.some((p) => p.status === 'running')).toBe(true);

    const channel = await subscribeTranscript(server!, sid);
    expect(channel.reset().snapshot.meta.activity).toBe('turn');
    await idle(server!, base, sid);
    expect((await getTranscript(server!, base, sid)).meta.activity).toBe('idle');
    channel.close();
  });

  it('S6: REST snapshot and WS reset agree on every global entity', async () => {
    await boot([
      { match: (body) => !body.includes('echo s6'), respond: () => sseToolCall('call_s6', 'Bash', '{"command":"echo s6"}') },
      { match: () => true, respond: () => sseText('s6 done') },
    ]);
    const sid = await createSession(server!, base);
    await submitPrompt(server!, base, sid, 'run echo for s6');
    await idle(server!, base, sid);

    const snapshot = await getTranscript(server!, base, sid);
    const channel = await subscribeTranscript(server!, sid);
    const reset = channel.reset().snapshot;

    expect(reset.meta).toEqual(snapshot.meta);
    const byId = (xs: any[], key: string): Record<string, unknown> =>
      Object.fromEntries(xs.map((x) => [x[key], x]));
    expect(Object.keys(byId(reset.tasks ?? [], 'taskId')).sort()).toEqual(
      Object.keys(byId(snapshot.tasks, 'taskId')).sort(),
    );
    expect(Object.keys(byId(reset.interactions ?? [], 'interactionId')).sort()).toEqual(
      Object.keys(byId(snapshot.interactions, 'interactionId')).sort(),
    );
    expect(Object.keys(byId(reset.prompts ?? [], 'promptId')).sort()).toEqual(
      Object.keys(byId(snapshot.prompts, 'promptId')).sort(),
    );
    expect(Object.keys(byId(reset.todos ?? [], 'todoId')).sort()).toEqual(
      Object.keys(byId(snapshot.todos, 'todoId')).sort(),
    );
    channel.close();
  });
}, 90000);
