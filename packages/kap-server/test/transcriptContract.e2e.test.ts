
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import {
  IAgentLifecycleService,
  IAgentPlanService,
  IAgentTaskService,
  IConfigService,
  closeSessionById,
  MAIN_AGENT_ID,
  getLiveSessionById,
  interactions,
  resumeSessionById,
  type AgentTask,
  type ApprovalRequest,
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
  readonly delayMs?: number;
  readonly status?: number;
  readonly hold?: () => Promise<void>;
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
        if (route?.status !== undefined) {
          res.writeHead(route.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: respond(), type: 'invalid_request_error' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(respond());
      };
      if (route?.hold !== undefined) void route.hold().then(send);
      else if (route?.delayMs !== undefined) setTimeout(send, route.delayMs);
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

async function restCode(server: RunningServer, base: string, path: string, body: unknown = {}): Promise<number> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: authHeaders(server, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
  return ((await res.json()) as Envelope<unknown>).code;
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

const getSessionFacts = (server: RunningServer, base: string, sid: string): Promise<{ busy: boolean; pending_interaction?: string }> =>
  rest(server, base, `/api/v1/sessions/${encodeURIComponent(sid)}`);

async function createSession(server: RunningServer, base: string): Promise<string> {
  const data = await rest<{ id: string }>(server, base, '/api/v1/sessions', {
    method: 'POST',
    body: { metadata: { cwd: '/tmp' } },
  });
  return data.id;
}

function submitPrompt(server: RunningServer, base: string, sid: string, text: string, permissionMode: 'manual' | 'yolo' | 'auto' = 'yolo'): Promise<{ prompt_id: string; status: string }> {
  return rest<{ prompt_id: string; status: string }>(server, base, `/api/v1/sessions/${encodeURIComponent(sid)}/prompts`, {
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
  readonly tasks: any[];
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
  const tasks: any[] = [];
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
    if (frame.type === 'task') tasks.push(frame);
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
    tasks,
    reset: () => resetFrame?.payload,
    close: () => ws.close(),
  };
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


describe('transcript contract e2e', () => {
  let home: string | undefined;
  let server: RunningServer | undefined;
  let llm: MockLlm | undefined;
  let base: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-transcript-contract-'));
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
  });

  async function boot(routes: readonly LlmRoute[]): Promise<void> {
    llm = await startMockLlm(routes);
    await writeFile(join(home!, 'config.toml'), configToml(llm.port), 'utf-8');
    await server!.core.accessor.get(IConfigService).reload();
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

    const channel = await subscribeTranscript(server!, sid);
    try {
      const second = await submitPrompt(server!, base, sid, 'second prompt');
      expect(second.status).toBe('queued');
      await until('second prompt queued', async () => {
        const tx = await getTranscript(server!, base, sid);
        return tx.prompts.some((p) => p.status === 'queued') && tx.prompts.some((p) => p.status === 'running');
      });
      const mid = await getTranscript(server!, base, sid);
      expect(mid.prompts.map((p) => p.status).toSorted()).toEqual(['queued', 'running']);
      const queueFrames = () => channel.frames.filter((f) => f.type === 'queue' && f.agent_id === 'main');
      await until('queue frame lists the second prompt', () =>
        queueFrames().some((f) => f.inputs.some((input: any) => input.prompt_id === second.prompt_id)),
      );
      expect(queueFrames().at(-1)).toMatchObject({
        paused: false,
        inputs: [{ prompt_id: second.prompt_id, kind: 'input', delivery: 'queue', content: [{ type: 'text', text: 'second prompt' }] }],
      });

      await until('both settled', async () => {
        const tx = await getTranscript(server!, base, sid);
        return tx.prompts.length > 0 && tx.prompts.every((p) => p.status === 'completed');
      }, 45000);
      await until('queue drained', () => queueFrames().at(-1)?.inputs.length === 0);
    } finally {
      channel.close();
    }
  });

  it('pauses, reorders, steers and withdraws prompts queued behind a running turn', async () => {
    await boot([
      { match: (body) => body.includes('first prompt'), respond: () => sseText('first done'), delayMs: 3000 },
      { match: () => true, respond: () => sseText('later done') },
    ]);
    const sid = await createSession(server!, base);
    await submitPrompt(server!, base, sid, 'first prompt');
    await until('first prompt reaches model', () => llm!.hits.length > 0);
    const queuePath = `/api/v1/sessions/${sid}/agents/main/queue`;
    const queued = async () =>
      (await rest<{ queued: { prompt_id: string }[] }>(server!, base, `/api/v1/sessions/${sid}/prompts`)).queued.map(
        (prompt) => prompt.prompt_id,
      );

    const second = await submitPrompt(server!, base, sid, 'second prompt');
    const third = await submitPrompt(server!, base, sid, 'third prompt');
    expect([second.status, third.status]).toEqual(['queued', 'queued']);

    expect(await rest(server!, base, `${queuePath}:pause`, { method: 'POST', body: {} })).toEqual({ paused: true });
    await rest(server!, base, `${queuePath}/${third.prompt_id}:move`, { method: 'POST', body: { before_prompt_id: second.prompt_id } });
    expect(await queued()).toEqual([third.prompt_id, second.prompt_id]);
    expect(
      await rest(server!, base, `/api/v1/sessions/${sid}/prompts/${second.prompt_id}:steer`, { method: 'POST', body: {} }),
    ).toEqual({ steered: true, prompt_ids: [second.prompt_id] });
    expect(await queued()).toEqual([third.prompt_id]);

    expect(
      await rest(server!, base, `/api/v1/sessions/${sid}/prompts/${third.prompt_id}:abort`, { method: 'POST', body: {} }),
    ).toEqual({ aborted: true });
    expect(await queued()).toEqual([]);
    expect(await restCode(server!, base, `${queuePath}/${second.prompt_id}:move`, { before_prompt_id: 7 })).toBe(40001);
    expect(await restCode(server!, base, `${queuePath}/${second.prompt_id}:move`)).toBe(40402);
    expect(await restCode(server!, base, `/api/v1/sessions/${sid}/agents/agent-0/queue:pause`)).toBe(40001);

    await idle(server!, base, sid);
    const fourth = await submitPrompt(server!, base, sid, 'fourth prompt');
    expect(fourth.status).toBe('queued');
    expect(await queued()).toEqual([fourth.prompt_id]);
    expect(
      await rest(server!, base, `/api/v1/sessions/${sid}/prompts/${fourth.prompt_id}:abort`, { method: 'POST', body: {} }),
    ).toEqual({ aborted: true });
    expect(await rest(server!, base, `${queuePath}:resume`, { method: 'POST', body: {} })).toEqual({ paused: false });
    const tx = await getTranscript(server!, base, sid);
    expect(tx.items.filter((item) => item.kind === 'turn')).toHaveLength(1);
    expect(JSON.stringify(tx.items)).toContain('second prompt');
    expect(JSON.stringify(tx.items)).not.toContain('third prompt');
    expect(JSON.stringify(tx.items)).not.toContain('fourth prompt');
  });

  it('queues a compaction requested through :compact in order behind queued prompts', async () => {
    await boot([{ match: () => true, respond: () => sseText('done'), delayMs: 2000 }]);
    const sid = await createSession(server!, base);
    await submitPrompt(server!, base, sid, 'first prompt');
    await until('first prompt reaches model', () => llm!.hits.length > 0);
    const channel = await subscribeTranscript(server!, sid);
    try {
      const second = await submitPrompt(server!, base, sid, 'second prompt');
      const queued = await rest<{ prompt_id: string; accepted_as: string }>(
        server!,
        base,
        `/api/v1/sessions/${sid}:compact`,
        { method: 'POST', body: { instruction: '  keep the plan  ' } },
      );
      expect(queued.accepted_as).toBe('queue');
      expect(await restCode(server!, base, `/api/v1/sessions/${sid}:compact`)).toBe(40910);
      const queueFrames = () => channel.frames.filter((f) => f.type === 'queue' && f.agent_id === 'main');
      await until('queue frame lists the compaction', () =>
        queueFrames().some((f) => f.inputs.some((input: any) => input.prompt_id === queued.prompt_id)),
      );
      expect(queueFrames().at(-1).inputs).toMatchObject([
        { prompt_id: second.prompt_id, kind: 'input' },
        { prompt_id: queued.prompt_id, kind: 'compact', instruction: 'keep the plan', content: [] },
      ]);

      await until('queued compaction runs', () => llm!.hits.some((hit) => hit.includes('keep the plan')), 30000);
      const secondHit = llm!.hits.findIndex((hit) => hit.includes('second prompt'));
      const compactHit = llm!.hits.findIndex((hit) => hit.includes('keep the plan'));
      expect(secondHit).toBeGreaterThan(-1);
      expect(secondHit).toBeLessThan(compactHit);
      await until('queue drained', () => queueFrames().at(-1)?.inputs.length === 0);
      await idle(server!, base, sid);
    } finally {
      channel.close();
    }
  });

  it('steers only up to a queued /compact and runs the rest in order without stalling', async () => {
    let firstServed = false;
    await boot([
      {
        match: () => {
          if (firstServed) return false;
          firstServed = true;
          return true;
        },
        respond: () => sseText('first done'),
        delayMs: 3000,
      },
      { match: (body) => body.includes('keep the plan'), respond: () => sseText('Compacted summary.') },
      { match: () => true, respond: () => sseText('done') },
    ]);
    const sid = await createSession(server!, base);
    await submitPrompt(server!, base, sid, 'first prompt');
    await until('first prompt reaches model', () => llm!.hits.length > 0);
    const channel = await subscribeTranscript(server!, sid);
    try {
      const a = await submitPrompt(server!, base, sid, 'prompt A');
      const compact = await rest<{ prompt_id: string; accepted_as: string }>(server!, base, `/api/v1/sessions/${sid}:compact`, {
        method: 'POST',
        body: { instruction: 'keep the plan' },
      });
      const b = await submitPrompt(server!, base, sid, 'prompt B');
      const c = await submitPrompt(server!, base, sid, 'prompt C');
      expect(compact.accepted_as).toBe('queue');
      const queueFrames = () => channel.frames.filter((f) => f.type === 'queue' && f.agent_id === 'main');
      const lastQueue = () => (queueFrames().at(-1)?.inputs ?? []).map((input: any) => input.prompt_id);
      await until('queue frame lists all four entries', () => lastQueue().length === 4);
      expect(lastQueue()).toEqual([a.prompt_id, compact.prompt_id, b.prompt_id, c.prompt_id]);

      expect(await rest(server!, base, `/api/v1/sessions/${sid}/prompts/${a.prompt_id}:steer`, { method: 'POST', body: {} })).toEqual({
        steered: true,
        prompt_ids: [a.prompt_id],
      });
      expect(await restCode(server!, base, `/api/v1/sessions/${sid}/prompts/${b.prompt_id}:steer`)).toBe(40001);
      expect(await restCode(server!, base, `/api/v1/sessions/${sid}/prompts/${compact.prompt_id}:steer`)).toBe(40001);
      expect(await restCode(server!, base, `/api/v1/sessions/${sid}/prompts:steer`, { prompt_ids: [c.prompt_id] })).toBe(40001);
      await until('queue frame drops the steered prompt', () => lastQueue().length === 3);
      expect(lastQueue()).toEqual([compact.prompt_id, b.prompt_id, c.prompt_id]);

      await until('queue drained', () => queueFrames().at(-1)?.inputs.length === 0, 45000);
      await idle(server!, base, sid);
      const position = (marker: string) => llm!.hits.findIndex((hit, index) => index > 0 && hit.includes(marker));
      expect(llm!.hits).toHaveLength(5);
      expect(position('prompt A')).toBe(1);
      expect(position('keep the plan')).toBe(2);
      expect(llm!.hits[3]).toContain('prompt B');
      expect(llm!.hits[3]).not.toContain('prompt C');
      expect(llm!.hits[4]).toContain('prompt C');
      const tx = await getTranscript(server!, base, sid);
      const statusOf = (id: string) => tx.prompts.find((prompt) => prompt.promptId === id)?.status;
      expect([a, b, c].map((prompt) => statusOf(prompt.prompt_id))).toEqual(['completed', 'completed', 'completed']);
      expect(tx.prompts.some((prompt) => prompt.promptId === compact.prompt_id)).toBe(false);
    } finally {
      channel.close();
    }
  });

  describe('prompt queue', () => {
    function gate(): { readonly wait: () => Promise<void>; readonly open: () => void } {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { wait: () => opened, open };
    }

    function heldOnce(hold: () => Promise<void>, match: (body: string) => boolean = () => true): LlmRoute {
      let served = false;
      return {
        match: (body) => {
          if (served || !match(body)) return false;
          served = true;
          return true;
        },
        respond: () => sseText('held done'),
        hold,
      };
    }

    const firstHit = (marker: string): number => llm!.hits.findIndex((hit) => hit.includes(marker));
    const ranInOrder = (markers: readonly string[]): boolean => {
      const hits = markers.map(firstHit);
      return hits.every((hit, index) => hit > 0 && (index === 0 || hit > hits[index - 1]!));
    };
    const post = <T,>(path: string, body: unknown = {}): Promise<T> => rest<T>(server!, base, path, { method: 'POST', body });
    const submit = (sid: string, text: string, extra: Record<string, unknown> = {}) =>
      post<{ prompt_id: string; status: string }>(`/api/v1/sessions/${sid}/prompts`, {
        content: [{ type: 'text', text }],
        model: 'stub',
        permission_mode: 'yolo',
        ...extra,
      });
    const compact = (sid: string, instruction?: string) =>
      post<{ prompt_id: string; accepted_as: string }>(`/api/v1/sessions/${sid}:compact`, instruction === undefined ? {} : { instruction });
    const mainQueue = (channel: TranscriptChannel): { paused: boolean; ids: string[] } | undefined => {
      const frame = channel.frames.filter((f) => f.type === 'queue' && f.agent_id === 'main').at(-1);
      return frame === undefined ? undefined : { paused: frame.paused, ids: frame.inputs.map((input: any) => input.prompt_id) };
    };
    const turnsOf = async (sid: string) => (await getTranscript(server!, base, sid)).items.filter((item) => item.kind === 'turn');

    it('runs queued prompts once each, in submission order, and mirrors them in frames and GET /prompts', async () => {
      const hold = gate();
      await boot([heldOnce(hold.wait)]);
      const sid = await createSession(server!, base);
      await submit(sid, 'first prompt');
      const channel = await subscribeTranscript(server!, sid);
      try {
        await until('first request', () => llm!.hits.length === 1);
        const queued = [];
        for (const text of ['queued one', 'queued two', 'queued three']) queued.push(await submit(sid, text));
        expect(queued.map((item) => item.status)).toEqual(['queued', 'queued', 'queued']);
        const ids = queued.map((item) => item.prompt_id);
        await until('frame lists the queue', () => mainQueue(channel)?.ids.length === 3);
        expect(mainQueue(channel)).toEqual({ paused: false, ids });
        const listed = await rest<{ queued: { prompt_id: string }[] }>(server!, base, `/api/v1/sessions/${sid}/prompts`);
        expect(listed.queued.map((item) => item.prompt_id)).toEqual(ids);

        hold.open();
        await until('queue drained', () => mainQueue(channel)?.ids.length === 0 && firstHit('queued three') > 0, 30000);
        await idle(server!, base, sid);
        expect(ranInOrder(['queued one', 'queued two', 'queued three'])).toBe(true);
        expect(await turnsOf(sid)).toHaveLength(4);
        const tx = await getTranscript(server!, base, sid);
        expect(tx.prompts.map((prompt) => prompt.status)).toEqual(['completed', 'completed', 'completed', 'completed']);
      } finally {
        channel.close();
      }
    });

    it('pauses without stopping the running turn, holds prompts on an idle paused queue, and resumes in order', async () => {
      const hold = gate();
      await boot([heldOnce(hold.wait)]);
      const sid = await createSession(server!, base);
      const queuePath = `/api/v1/sessions/${sid}/agents/main/queue`;
      await submit(sid, 'first prompt');
      const channel = await subscribeTranscript(server!, sid);
      try {
        await until('first request', () => llm!.hits.length === 1);
        expect(await post(`${queuePath}:pause`)).toEqual({ paused: true });
        const a = await submit(sid, 'paused one');
        hold.open();
        await until('first prompt finished', async () => (await getTranscript(server!, base, sid)).prompts[0]?.status === 'completed');
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(firstHit('paused one')).toBe(-1);
        const b = await submit(sid, 'paused two');
        expect(b.status).toBe('queued');
        await until('paused frame', () => mainQueue(channel)?.ids.length === 2);
        expect(mainQueue(channel)).toEqual({ paused: true, ids: [a.prompt_id, b.prompt_id] });

        expect(await post(`${queuePath}:resume`)).toEqual({ paused: false });
        await until('queue drained', () => firstHit('paused two') > 0 && mainQueue(channel)?.ids.length === 0, 30000);
        await idle(server!, base, sid);
        expect(ranInOrder(['paused one', 'paused two'])).toBe(true);
        expect(mainQueue(channel)?.paused).toBe(false);
      } finally {
        channel.close();
      }
    });

    it('reorders prompts and a compaction while paused and runs them in the new order', async () => {
      await boot([{ match: (body) => body.includes('keep the plan'), respond: () => sseText('Compacted summary.') }]);
      const sid = await createSession(server!, base);
      const queuePath = `/api/v1/sessions/${sid}/agents/main/queue`;
      await submit(sid, 'warm up');
      await idle(server!, base, sid);
      const channel = await subscribeTranscript(server!, sid);
      try {
        await post(`${queuePath}:pause`);
        const a = (await submit(sid, 'prompt A')).prompt_id;
        const b = (await submit(sid, 'prompt B')).prompt_id;
        const k = (await compact(sid, 'keep the plan')).prompt_id;
        const c = (await submit(sid, 'prompt C')).prompt_id;
        await until('frame lists the queue', () => mainQueue(channel)?.ids.length === 4);
        expect(mainQueue(channel)?.ids).toEqual([a, b, k, c]);

        await post(`${queuePath}/${c}:move`, { before_prompt_id: a });
        await post(`${queuePath}/${k}:move`, { before_prompt_id: a });
        await until('moved frame', () => mainQueue(channel)?.ids.join() === [c, k, a, b].join());
        expect(await restCode(server!, base, `${queuePath}/missing:move`)).toBe(40402);
        expect(await restCode(server!, base, `${queuePath}/${a}:move`, { before_prompt_id: 'missing' })).toBe(40402);
        expect(await restCode(server!, base, `${queuePath}/${a}:move`, { before_prompt_id: 7 })).toBe(40001);

        await post(`${queuePath}:resume`);
        await until('queue drained', () => mainQueue(channel)?.ids.length === 0, 30000);
        await idle(server!, base, sid);
        expect(ranInOrder(['prompt C', 'keep the plan', 'prompt A', 'prompt B'])).toBe(true);
      } finally {
        channel.close();
      }
    });

    it('withdraws queued prompts and a queued compaction, and reports prompts that are no longer queued', async () => {
      const hold = gate();
      await boot([heldOnce(hold.wait)]);
      const sid = await createSession(server!, base);
      const first = await submit(sid, 'first prompt');
      const channel = await subscribeTranscript(server!, sid);
      try {
        await until('first request', () => llm!.hits.length === 1);
        const a = (await submit(sid, 'withdrawn prompt')).prompt_id;
        const k = (await compact(sid, 'keep the plan')).prompt_id;
        const b = (await submit(sid, 'kept prompt')).prompt_id;
        expect(await post(`/api/v1/sessions/${sid}/prompts/${a}:abort`)).toEqual({ aborted: true });
        expect(await post(`/api/v1/sessions/${sid}/prompts/${k}:abort`)).toEqual({ aborted: true });
        expect(await restCode(server!, base, `/api/v1/sessions/${sid}/prompts/missing:abort`)).toBe(40402);
        await until('frame keeps one prompt', () => mainQueue(channel)?.ids.join() === b);

        hold.open();
        await until('kept prompt ran', () => firstHit('kept prompt') > 0, 30000);
        await idle(server!, base, sid);
        expect(firstHit('withdrawn prompt')).toBe(-1);
        expect(firstHit('keep the plan')).toBe(-1);
        expect(await restCode(server!, base, `/api/v1/sessions/${sid}/prompts/${first.prompt_id}:abort`)).toBe(40402);
        expect(mainQueue(channel)?.ids).toEqual([]);
      } finally {
        channel.close();
      }
    });

    it('enters Plan mode for a queued prompt only when it starts and keeps steers from passing it', async () => {
      const hold = gate();
      await boot([heldOnce(hold.wait)]);
      const sid = await createSession(server!, base);
      try {
        await submit(sid, 'first prompt');
        await until('first request', () => llm!.hits.length === 1);
        const a = (await submit(sid, 'prompt A')).prompt_id;
        const planned = (await submit(sid, 'plan prompt', { plan_mode: true })).prompt_id;
        const b = (await submit(sid, 'prompt B')).prompt_id;
        expect(await restCode(server!, base, `/api/v1/sessions/${sid}/prompts/${planned}:steer`)).toBe(40001);
        expect(await restCode(server!, base, `/api/v1/sessions/${sid}/prompts/${b}:steer`)).toBe(40001);
        expect(await post(`/api/v1/sessions/${sid}/prompts/${a}:steer`)).toEqual({ steered: true, prompt_ids: [a] });
        expect((await getTranscript(server!, base, sid)).meta.modes).not.toMatchObject({ plan: {} });

        hold.open();
        await until('queue drained', () => firstHit('prompt B') > 0, 30000);
        await idle(server!, base, sid);
        expect(ranInOrder(['prompt A', 'plan prompt', 'prompt B'])).toBe(true);
        expect((await getTranscript(server!, base, sid)).meta.modes).toMatchObject({ plan: {} });
      } finally {
        void sid;
      }
    });

    it('moves on to the next queued prompt when one fails or the running turn is aborted', async () => {
      const hold = gate();
      const slow = gate();
      await boot([
        heldOnce(hold.wait),
        { match: (body) => body.includes('failing prompt') && !body.includes('after failure'), respond: () => 'mock refusal', status: 400 },
        heldOnce(slow.wait, (body) => body.includes('slow prompt')),
      ]);
      const sid = await createSession(server!, base);
      await submit(sid, 'first prompt');
      const channel = await subscribeTranscript(server!, sid);
      try {
        await until('first request', () => llm!.hits.length === 1);
        await submit(sid, 'failing prompt');
        await submit(sid, 'after failure');
        hold.open();
        await until('prompt after the failure ran', () => firstHit('after failure') > 0, 30000);
        await idle(server!, base, sid);
        const turns = await turnsOf(sid);
        expect(turns.map((turn) => turn.state)).toEqual(['completed', 'failed', 'completed']);

        const slowPrompt = (await submit(sid, 'slow prompt')).prompt_id;
        await until('slow request', () => firstHit('slow prompt') > 0);
        await submit(sid, 'after abort');
        expect(await post(`/api/v1/sessions/${sid}/prompts/${slowPrompt}:abort`)).toEqual({ aborted: true });
        await until('prompt after the abort ran', () => firstHit('after abort') > 0, 30000);
        slow.open();
        await idle(server!, base, sid);
        expect((await turnsOf(sid)).map((turn) => turn.state).slice(3)).toEqual(['cancelled', 'completed']);
        expect(mainQueue(channel)?.ids).toEqual([]);
      } finally {
        slow.open();
        channel.close();
      }
    });

    it('moves on to the queued prompts when a queued compaction fails', async () => {
      const hold = gate();
      await boot([
        heldOnce(hold.wait),
        { match: (body) => body.includes('keep the plan'), respond: () => 'mock refusal', status: 400 },
      ]);
      const sid = await createSession(server!, base);
      await submit(sid, 'first prompt');
      const channel = await subscribeTranscript(server!, sid);
      try {
        await until('first request', () => llm!.hits.length === 1);
        expect((await compact(sid, 'keep the plan')).accepted_as).toBe('queue');
        await submit(sid, 'after compaction');
        hold.open();
        await until('prompt after the compaction ran', () => firstHit('after compaction') > 0, 30000);
        await idle(server!, base, sid);
        expect(ranInOrder(['keep the plan', 'after compaction'])).toBe(true);
        expect(mainQueue(channel)?.ids).toEqual([]);
        expect((await compact(sid, 'final pass')).accepted_as).toBe('compact');
        await until('final compaction reached the model', () => firstHit('final pass') > 0, 30000);
        await idle(server!, base, sid);
      } finally {
        channel.close();
      }
    });

    it('refuses reload while the queue holds work and queue controls for other agents', async () => {
      await boot([]);
      const sid = await createSession(server!, base);
      const queuePath = `/api/v1/sessions/${sid}/agents/main/queue`;
      await submit(sid, 'warm up');
      await idle(server!, base, sid);
      await post(`${queuePath}:pause`);
      const held = (await submit(sid, 'held prompt')).prompt_id;
      expect(await restCode(server!, base, `/api/v1/sessions/${sid}:reload`)).toBe(40901);
      await post(`/api/v1/sessions/${sid}/prompts/${held}:abort`);
      expect(await restCode(server!, base, `/api/v1/sessions/${sid}:reload`)).toBe(40901);
      await post(`${queuePath}:resume`);
      expect(await restCode(server!, base, `/api/v1/sessions/${sid}:reload`)).toBe(0);
      for (const action of ['queue:pause', 'queue:resume', `queue/${held}:move`]) {
        expect(await restCode(server!, base, `/api/v1/sessions/${sid}/agents/agent-0/${action}`)).toBe(40001);
      }
      expect(firstHit('held prompt')).toBe(-1);
    });

    it('sends the current queue to a client that subscribes later', async () => {
      const hold = gate();
      await boot([heldOnce(hold.wait)]);
      const sid = await createSession(server!, base);
      try {
        await submit(sid, 'first prompt');
        await until('first request', () => llm!.hits.length === 1);
        const a = (await submit(sid, 'prompt A')).prompt_id;
        const k = (await compact(sid, 'keep the plan')).prompt_id;
        await post(`/api/v1/sessions/${sid}/agents/main/queue:pause`);
        const late = await subscribeTranscript(server!, sid);
        try {
          await until('late subscriber gets the queue', () => mainQueue(late) !== undefined);
          expect(mainQueue(late)).toEqual({ paused: true, ids: [a, k] });
        } finally {
          late.close();
        }
        await post(`/api/v1/sessions/${sid}/prompts/${a}:abort`);
        await post(`/api/v1/sessions/${sid}/prompts/${k}:abort`);
        await post(`/api/v1/sessions/${sid}/agents/main/queue:resume`);
      } finally {
        hold.open();
      }
      await idle(server!, base, sid);
    });

    it('steers into the running turn while paused, undoes over a paused queue, and compacts an idle paused queue at once', async () => {
      const hold = gate();
      await boot([
        heldOnce(hold.wait),
        { match: (body) => body.includes('keep the plan'), respond: () => sseText('Compacted summary.') },
      ]);
      const sid = await createSession(server!, base);
      const queuePath = `/api/v1/sessions/${sid}/agents/main/queue`;
      await submit(sid, 'first prompt');
      const channel = await subscribeTranscript(server!, sid);
      try {
        await until('first request', () => llm!.hits.length === 1);
        const a = (await submit(sid, 'steered while paused')).prompt_id;
        const b = (await submit(sid, 'waits while paused')).prompt_id;
        await post(`${queuePath}:pause`);
        expect(await post(`/api/v1/sessions/${sid}/prompts/${a}:steer`)).toEqual({ steered: true, prompt_ids: [a] });
        hold.open();
        await until('steer answered', () => firstHit('steered while paused') > 0, 30000);
        await until('first turn settled', async () => !(await getSessionFacts(server!, base, sid)).busy, 30000);
        expect(firstHit('waits while paused')).toBe(-1);
        expect(mainQueue(channel)).toEqual({ paused: true, ids: [b] });

        expect(await restCode(server!, base, `/api/v1/sessions/${sid}:undo`, { count: 1 })).toBe(0);
        expect(await turnsOf(sid)).toHaveLength(0);
        const queuedCompaction = await compact(sid, 'keep the plan');
        expect(queuedCompaction.accepted_as).toBe('queue');
        expect(await post(`/api/v1/sessions/${sid}/prompts/${queuedCompaction.prompt_id}:abort`)).toEqual({ aborted: true });

        await post(`${queuePath}:resume`);
        await until('waiting prompt ran', () => firstHit('waits while paused') > 0, 30000);
        await idle(server!, base, sid);
        const last = llm!.hits.findLast((hit) => hit.includes('waits while paused'))!;
        expect(last).not.toContain('first prompt');
        expect(await turnsOf(sid)).toHaveLength(1);

        await post(`${queuePath}:pause`);
        expect((await compact(sid, 'keep the plan')).accepted_as).toBe('compact');
        await until('compaction ran', () => firstHit('keep the plan') > 0, 30000);
        await idle(server!, base, sid);
        expect(mainQueue(channel)).toEqual({ paused: true, ids: [] });
        await post(`${queuePath}:resume`);
      } finally {
        channel.close();
      }
    });

    it('runs concurrent submissions made while busy exactly once each', async () => {
      const hold = gate();
      await boot([heldOnce(hold.wait)]);
      const sid = await createSession(server!, base);
      await submit(sid, 'first prompt');
      const channel = await subscribeTranscript(server!, sid);
      try {
        await until('first request', () => llm!.hits.length === 1);
        const texts = ['burst 1', 'burst 2', 'burst 3', 'burst 4', 'burst 5'];
        const accepted = await Promise.all(texts.map((text) => submit(sid, text)));
        expect(new Set(accepted.map((item) => item.prompt_id)).size).toBe(5);
        expect(accepted.every((item) => item.status === 'queued')).toBe(true);
        await until('frame lists the burst', () => mainQueue(channel)?.ids.length === 5);
        const frameOrder = mainQueue(channel)!.ids;
        expect(new Set(frameOrder)).toEqual(new Set(accepted.map((item) => item.prompt_id)));

        hold.open();
        await until('burst drained', () => texts.every((text) => firstHit(text) > 0) && mainQueue(channel)?.ids.length === 0, 30000);
        await idle(server!, base, sid);
        const byId = new Map(accepted.map((item, index) => [item.prompt_id, texts[index]!]));
        expect(ranInOrder(frameOrder.map((id) => byId.get(id)!))).toBe(true);
        expect(await turnsOf(sid)).toHaveLength(6);
      } finally {
        channel.close();
      }
    });
  });

  it('undo rebuilds a steered turn consistently over REST and WebSocket', async () => {
    await boot([
      { match: (body) => body.includes('steered request'), respond: () => sseText('answer after steer') },
      { match: (body) => body.includes('original request'), respond: () => sseText('answer before steer'), delayMs: 1500 },
    ]);
    const sid = await createSession(server!, base);
    await submitPrompt(server!, base, sid, 'original request');
    await until('original request reaches model', () => llm!.hits.length > 0);
    const channel = await subscribeTranscript(server!, sid);
    try {
      const steer = await submitPrompt(server!, base, sid, 'steered request');
      await rest(server!, base, `/api/v1/sessions/${sid}/prompts/${steer.prompt_id}:steer`, { method: 'POST', body: {} });
      await idle(server!, base, sid);
      const before = await getTranscript(server!, base, sid);
      expect(JSON.stringify(before.items)).toContain('answer after steer');
      expect(before.items.filter((item) => item.kind === 'turn')).toHaveLength(1);
      expect(before.prompts.some((prompt) => prompt.promptId === steer.prompt_id)).toBe(true);
      await rest(server!, base, `/api/v1/sessions/${sid}:undo`, { method: 'POST', body: { count: 1 } });
      const after = await getTranscript(server!, base, sid);
      expect(after.items.filter((item) => item.kind === 'turn')).toEqual([]);
      expect(JSON.stringify(after.items)).not.toContain('original request');
      expect(JSON.stringify(after.items)).not.toContain('answer before steer');
      expect(JSON.stringify(after.items)).not.toContain('steered request');
      expect(JSON.stringify(after.items)).not.toContain('answer after steer');
      expect(after.prompts).toEqual([]);
      await until('undo reset reaches subscriber', () => channel.ops.some((op) => op.op === 'reset'));
      expect(channel.ops.find((op) => op.op === 'reset').snapshot.items).toEqual(after.items);
      const reconnected = await subscribeTranscript(server!, sid);
      try {
        expect((await getTranscript(server!, base, sid)).items).toEqual(after.items);
        expect(reconnected.reset().snapshot.prompts).toEqual([]);
      } finally {
        reconnected.close();
      }
      await submitPrompt(server!, base, sid, 'steered request');
      await idle(server!, base, sid);
      const resent = await getTranscript(server!, base, sid);
      expect(resent.items.filter((item) => item.kind === 'turn').map((turn) => turn.prompt)).toEqual(['steered request']);
      expect(resent.prompts.some((prompt) => prompt.promptId === steer.prompt_id)).toBe(false);
      await closeSessionById(server!.core.accessor, sid);
      const reopened = await getTranscript(server!, base, sid);
      expect(reopened.items.filter((item) => item.kind === 'turn').map((turn) => turn.prompt)).toEqual(['steered request']);
      await rest(server!, base, `/api/v1/sessions/${sid}:undo`, { method: 'POST', body: { count: 1 } });
      const empty = await getTranscript(server!, base, sid);
      expect(empty.items.filter((item) => item.kind === 'turn')).toEqual([]);
      expect(empty.prompts).toEqual([]);
    } finally {
      channel.close();
    }
  }, 30000);

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

    await rest(server!, base, `/api/v1/sessions/${encodeURIComponent(sid)}/interactions/${encodeURIComponent(approval.interactionId)}`, {
      method: 'POST',
      body: { kind: 'approval', decision: 'approved' },
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

  it.each([
    ['approved', { decision: 'approved' }, false, 'Exited plan mode'],
    ['revised', { decision: 'rejected', feedback: 'Cover the error path too.' }, true, 'Cover the error path too.'],
    ['dismissed', { decision: 'cancelled' }, true, 'Plan approval dismissed'],
  ] as const)('S8: in Never Ask, a plan waits for review over REST and is %s', async (_label, response, staysInPlan, output) => {
    await boot([
      {
        match: (body) => body.includes('Plan the greeting change') && !body.includes('call_exit_plan'),
        respond: () => sseToolCall('call_exit_plan', 'ExitPlanMode', '{}'),
      },
      { match: () => true, respond: () => sseText('done') },
    ]);
    const sid = await createSession(server!, base);
    await rest(server!, base, `/api/v1/sessions/${encodeURIComponent(sid)}/profile`, {
      method: 'POST',
      body: { agent_config: { plan_mode: true, permission_mode: 'auto' } },
    });
    const planService = getLiveSessionById(server!.core.accessor, sid)!
      .accessor.get(IAgentLifecycleService)
      .handleOf(MAIN_AGENT_ID)!
      .accessor.get(IAgentPlanService);
    const planPath = (await planService.status())!.path!;
    await mkdir(dirname(planPath), { recursive: true });
    await writeFile(planPath, '# Plan\n\n- Change the greeting\n- Add a test', 'utf-8');

    await submitPrompt(server!, base, sid, 'Plan the greeting change', 'auto');

    const pendingReview = () =>
      interactions
        .findAll({ kind: 'approval', resolved: false, tags: { sessionId: sid } })
        .find((item) => (item.payload as ApprovalRequest).toolName === 'ExitPlanMode');
    await until('plan review pending', async () => pendingReview() !== undefined);
    const review = pendingReview()!;
    const approvalId = review.id;
    expect((review.payload as ApprovalRequest).display).toMatchObject({
      kind: 'plan_review',
      plan: '# Plan\n\n- Change the greeting\n- Add a test',
      path: planPath,
    });
    expect((await getSessionFacts(server!, base, sid)).pending_interaction).toBe('approval');
    const mid = await getTranscript(server!, base, sid);
    expect(mid.interactions.some((x: any) => x.interactionId === approvalId && x.state === 'pending')).toBe(true);
    expect(await planService.status()).not.toBeNull();

    await rest(server!, base, `/api/v1/sessions/${encodeURIComponent(sid)}/interactions/${encodeURIComponent(approvalId)}`, {
      method: 'POST',
      body: { kind: 'approval', ...response },
    });
    await idleOrDump(server!, base, sid);

    expect((await planService.status()) !== null).toBe(staysInPlan);
    const end = await getTranscript(server!, base, sid);
    expect(end.interactions.every((x: any) => x.state !== 'pending')).toBe(true);
    const toolFrame = end.items
      .filter((i) => i.kind === 'turn')
      .flatMap((t: any) => t.steps)
      .flatMap((s: any) => s.frames)
      .find((f: any) => f.kind === 'tool' && f.name === 'ExitPlanMode');
    expect(String(toolFrame.output)).toContain(output);
  });

  it('S4: a background subagent streams task events and a task-origin notification turn', async () => {
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
    const channel = await subscribeTranscript(server!, sid);

    await until('background task running', () =>
      channel.tasks.some((t) => t.kind === 'subagent' && t.status === 'running'),
    );
    const task = channel.tasks.find((t) => t.kind === 'subagent');
    expect(task).toMatchObject({
      session_id: sid,
      agent_id: MAIN_AGENT_ID,
      status: 'running',
      phase: 'working',
      detached: true,
    });
    expect(typeof task.child_agent_id).toBe('string');

    await until(
      'task completed',
      () => channel.tasks.some((t) => t.task_id === task.task_id && t.outcome === 'completed'),
      45000,
    ).catch((error: unknown) => {
      throw new Error(`${(error as Error).message}\ntasks: ${JSON.stringify(channel.tasks)}`, { cause: error });
    });
    await until('notification turn exists', async () => {
      const tx = await getTranscript(server!, base, sid);
      return tx.items.some((i: any) => i.kind === 'turn' && i.origin?.kind === 'task');
    }, 45000);

    const end = await getTranscript(server!, base, sid);
    const taskTurn = end.items.find((i: any) => i.kind === 'turn' && i.origin?.kind === 'task');
    expect(taskTurn).toBeDefined();
    expect(JSON.stringify(taskTurn)).toContain('notification');
    expect(end).not.toHaveProperty('tasks');
    expect(channel.ops.some((op) => op.op === 'task.upsert')).toBe(false);
    await idleOrDump(server!, base, sid);
    expect((await getTranscript(server!, base, sid)).meta.activity).toBe('idle');
    channel.close();
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
    expect(reset).not.toHaveProperty('tasks');
    expect(snapshot).not.toHaveProperty('tasks');
    const byId = (xs: any[], key: string): Record<string, unknown> =>
      Object.fromEntries(xs.map((x) => [x[key], x]));
    expect(Object.keys(byId(reset.interactions ?? [], 'interactionId')).toSorted()).toEqual(
      Object.keys(byId(snapshot.interactions, 'interactionId')).toSorted(),
    );
    expect(Object.keys(byId(reset.prompts ?? [], 'promptId')).toSorted()).toEqual(
      Object.keys(byId(snapshot.prompts, 'promptId')).toSorted(),
    );
    expect(Object.keys(byId(reset.todos ?? [], 'todoId')).toSorted()).toEqual(
      Object.keys(byId(snapshot.todos, 'todoId')).toSorted(),
    );
    channel.close();
  });

  it('S9: task.watch streams a running task output and resumes from since_offset', async () => {
    const sid = await createSession(server!, base);
    const agents = getLiveSessionById(server!.core.accessor, sid)!.accessor.get(IAgentLifecycleService);
    if (agents.handleOf(MAIN_AGENT_ID) === undefined) await agents.create({ agentId: MAIN_AGENT_ID });
    let sink: Parameters<AgentTask['start']>[0] | undefined;
    const taskId = agents.handleOf(MAIN_AGENT_ID)!.accessor.get(IAgentTaskService).registerTask({
      idPrefix: 'bash',
      kind: 'process',
      description: 'npm run dev',
      start: (s) => {
        sink = s;
        s.appendOutput('  VITE ready\n');
      },
      toInfo: (base) => ({ ...base, kind: 'process', command: 'npm run dev', pid: 0, exitCode: null }),
    });
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
    sink!.appendOutput('  ➜  Local: http://localhost:5173/\n');
    expect(await first.next(isOutput)).toMatchObject({ offset: 13, text: '  ➜  Local: http://localhost:5173/\n' });
    await first.close();

    sink!.appendOutput('4:42:10 PM [vite] hmr update /src/App.vue\n');
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
    const childTaskId = agents.handleOf(child.agentId)!.accessor.get(IAgentTaskService).registerTask({
      idPrefix: 'bash',
      kind: 'process',
      description: 'pnpm test --watch',
      start: (s) => {
        s.appendOutput(' RUN  v3.2.4\n');
      },
      toInfo: (base) => ({ ...base, kind: 'process', command: 'pnpm test --watch', pid: 0, exitCode: null }),
    });
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

    const end = await getTranscript(server, base, sid);
    const agentFrames = end.items
      .filter((i) => i.kind === 'turn')
      .flatMap((t: any) => t.steps)
      .flatMap((s: any) => s.frames)
      .filter((f: any) => f.kind === 'tool' && f.name === 'Agent');
    expect(agentFrames).toHaveLength(2);
    expect(String(agentFrames[1].output)).toContain(`agent_id: ${childAgentId}`);
    expect(String(agentFrames[1].output)).toContain('the token is quartz-7731');
  }, 60000);
}, 90000);
