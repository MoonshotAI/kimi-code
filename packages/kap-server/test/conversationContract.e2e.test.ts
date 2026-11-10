
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
  closeSessionById,
  MAIN_AGENT_ID,
  getLiveSessionById,
  interactions,
  resumeSessionById,
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

function sseTextChunks(...parts: readonly string[]): string {
  return sseLines(
    ...parts.map((text) =>
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'mock',
        choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
      }),
    ),
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
  readonly pause?: { readonly afterEvents: number; readonly ms: number };
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
      const pause = route?.pause;
      const send = (): void => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (pause === undefined) {
          res.end(respond());
          return;
        }
        const events = respond().split(/(?<=\n\n)/);
        res.write(events.slice(0, pause.afterEvents).join(''));
        setTimeout(() => {
          res.end(events.slice(pause.afterEvents).join(''));
        }, pause.ms);
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

interface TurnsPage {
  turns: any[];
  has_more: boolean;
}

const getTurns = (server: RunningServer, base: string, sid: string, agentId = MAIN_AGENT_ID): Promise<TurnsPage> =>
  rest<TurnsPage>(server, base, `/api/v1/sessions/${encodeURIComponent(sid)}/agents/${agentId}/turns`);

const textOf = (item: any): string => String(item.text ?? '');

const toolItems = (page: TurnsPage, name?: string): any[] =>
  page.turns.flatMap((turn) => turn.items).filter((item: any) => item.type === 'tool_call' && (name === undefined || item.name === name));

function replayFrames(frames: readonly any[]): any[] {
  let turns: any[] = [];
  const turnOf = (turnId: string): any => turns.find((turn) => turn.turn_id === turnId);
  const itemOf = (frame: any): any => turnOf(frame.turn_id)?.items.find((item: any) => item.item_id === frame.item_id);
  for (const frame of frames) {
    switch (frame.type) {
      case 'turns':
        turns = structuredClone(frame.turns);
        break;
      case 'turns.removed':
        turns = turns.filter((turn) => !frame.turn_ids.includes(turn.turn_id));
        break;
      case 'turn.started':
      case 'turn.ended': {
        const index = turns.findIndex((turn) => turn.turn_id === frame.turn.turn_id);
        const turn = { ...structuredClone(frame.turn), items: index === -1 ? [] : turns[index].items };
        if (index === -1) turns.push(turn);
        else turns[index] = turn;
        turns.sort((a, b) => a.ordinal - b.ordinal);
        break;
      }
      case 'turn.updated': {
        const turn = turnOf(frame.turn_id);
        if (turn === undefined) break;
        if (frame.step !== undefined) {
          turn.steps = [...turn.steps.filter((step: any) => step.index !== frame.step.index), frame.step].toSorted((a: any, b: any) => a.index - b.index);
        }
        if (frame.retry === undefined) delete turn.retry;
        else turn.retry = frame.retry;
        break;
      }
      case 'item.started':
      case 'item.ended': {
        const turn = turnOf(frame.turn_id);
        if (turn === undefined) break;
        const index = turn.items.findIndex((item: any) => item.item_id === frame.item.item_id);
        if (index === -1) turn.items.push(structuredClone(frame.item));
        else turn.items[index] = structuredClone(frame.item);
        break;
      }
      case 'item.updated': {
        const item = itemOf(frame);
        if (item !== undefined) Object.assign(item, structuredClone(frame.set));
        break;
      }
      case 'item.delta': {
        const item = itemOf(frame);
        if (item !== undefined) item[frame.field] = (item[frame.field] ?? '') + frame.delta;
        break;
      }
      case 'item.removed': {
        const turn = turnOf(frame.turn_id);
        if (turn !== undefined) turn.items = turn.items.filter((item: any) => item.item_id !== frame.item_id);
        break;
      }
    }
  }
  return turns;
}

const getSessionFacts = (server: RunningServer, base: string, sid: string): Promise<{ busy: boolean; pending_interaction?: string }> =>
  rest(server, base, `/api/v1/sessions/${encodeURIComponent(sid)}`);

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

interface ConversationChannel {
  readonly frames: any[];
  readonly conversation: any[];
  readonly tasks: any[];
  readonly agents: any[];
  readonly todos: any[];
  snapshot(): any;
  turns(): any[];
  close(): void;
}

const CONVERSATION_FRAME_TYPES = new Set([
  'turns',
  'turns.removed',
  'turn.started',
  'turn.updated',
  'turn.ended',
  'item.started',
  'item.updated',
  'item.ended',
  'item.delta',
  'item.removed',
  'turns.failed',
  'notice',
]);

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

async function subscribeConversation(
  server: RunningServer,
  sid: string,
  agentId: string = MAIN_AGENT_ID,
): Promise<ConversationChannel> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/ws`, [`kimi-code.bearer.${bearerToken(server)}`]);
  const frames: any[] = [];
  const conversation: any[] = [];
  const tasks: any[] = [];
  const agents: any[] = [];
  const todos: any[] = [];
  ws.on('message', (data) => {
    let frame: any;
    try {
      frame = JSON.parse(rawToString(data));
    } catch {
      return;
    }
    frames.push(frame);
    if (CONVERSATION_FRAME_TYPES.has(frame.type) && frame.agent_id === agentId) conversation.push(frame);
    if (frame.type === 'task') tasks.push(frame);
    if (frame.type === 'agent' && frame.agent_id === MAIN_AGENT_ID) agents.push(frame);
    if (frame.type === 'todo' && frame.agent_id === MAIN_AGENT_ID) todos.push(frame);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      resolve();
    });
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'subscribe', request_id: 'sub-1', session_id: sid, agent_ids: [agentId] }));
  await until('turns frame', () => conversation.some((frame) => frame.type === 'turns'), 15000);
  return {
    frames,
    conversation,
    tasks,
    agents,
    todos,
    snapshot: () => conversation.find((frame) => frame.type === 'turns'),
    turns: () => replayFrames(conversation),
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
  });

  async function boot(routes: readonly LlmRoute[]): Promise<void> {
    llm = await startMockLlm(routes);
    await writeFile(join(home!, 'config.toml'), configToml(llm.port), 'utf-8');
    await server!.core.accessor.get(IConfigService).reload();
  }

  const idle = (server: RunningServer, base: string, sid: string) =>
    until('session idle', async () => !(await getSessionFacts(server, base, sid)).busy);

  function dumpState(page: TurnsPage, hits: string[]): string {
    const turns = page.turns.map((turn) => ({
      id: turn.turn_id,
      status: `${turn.status}/${turn.outcome ?? ''}`,
      items: turn.items.map((item: any) => `${item.type}:${item.name ?? ''}:${item.status}`),
    }));
    const markers = hits
      .map((hit) => /"content":"([^"]{0,60})/.exec(hit)?.[1] ?? hit.slice(0, 60))
      .slice(0, 8);
    return `${JSON.stringify(turns)}\nllm hits (${hits.length}): ${JSON.stringify(markers)}`;
  }

  const idleOrDump = async (server: RunningServer, base: string, sid: string): Promise<void> => {
    try {
      await idle(server, base, sid);
    } catch (error) {
      const page = await getTurns(server, base, sid);
      throw new Error(`${(error as Error).message}\nturns at timeout: ${dumpState(page, llm?.hits ?? [])}`, { cause: error });
    }
  };

  it('S1: a turn streams items whose live ids match the final ones and both channels agree', async () => {
    await boot([{ match: () => true, respond: () => sseTextChunks('hello ', 'world'), delayMs: 1500 }]);
    const sid = await createSession(server!, base);
    const channel = await subscribeConversation(server!, sid);
    expect(channel.snapshot()).toMatchObject({ type: 'turns', session_id: sid, agent_id: MAIN_AGENT_ID, turns: [], has_more: false });
    const { prompt_id } = await submitPrompt(server!, base, sid, 'say hello');

    await idle(server!, base, sid);
    await until('turn.ended frame', () => channel.conversation.some((frame) => frame.type === 'turn.ended'));

    const end = await getTurns(server!, base, sid);
    expect(end.turns).toHaveLength(1);
    const [turn] = end.turns;
    expect(turn).toMatchObject({ ordinal: 0, turn_number: 0, kind: 'agent', status: 'ended', outcome: 'completed' });
    expect(turn.turn_id).toMatch(/^t_[0-9a-f]{12}$/);
    expect(turn).not.toHaveProperty('end_reason');
    expect(typeof turn.ended_at).toBe('string');
    expect(turn.steps).toEqual([expect.objectContaining({ index: 1, outcome: 'completed', usage: expect.objectContaining({ input_other: expect.any(Number), output: 4 }) })]);
    expect(turn.usage).toEqual(turn.steps[0].usage);
    expect(turn.items[0]).toMatchObject({ type: 'user_message', placement: 'opener', prompt_ids: [prompt_id], origin: { kind: 'user' }, text: 'say hello', attachments: [], skills: [] });
    const answer = turn.items.find((item: any) => item.type === 'assistant_message');
    expect(answer).toMatchObject({ status: 'ended', outcome: 'completed', text: 'hello world' });
    expect(channel.conversation.some((frame) => frame.type === 'item.started' && frame.item.item_id === answer.item_id)).toBe(true);
    expect(channel.conversation.some((frame) => frame.type === 'item.delta' && frame.item_id === answer.item_id && frame.field === 'text')).toBe(true);
    expect(channel.conversation.filter((frame) => frame.type === 'turn.updated').map((frame) => frame.step?.index)).toEqual([1]);
    expect(channel.turns()).toEqual(end.turns);

    expect(channel.agents.some((frame) => frame.status === 'running')).toBe(true);
    expect(channel.agents.every((frame) => frame.compacting === false)).toBe(true);
    for (const field of ['turn_number', 'prompt_id', 'retry']) {
      expect(channel.agents.every((frame) => !(field in frame))).toBe(true);
    }
    await until('agent idle frame', () => channel.agents.at(-1)?.status === 'idle');
    const turnEndedAt = channel.frames.findIndex((frame) => frame.type === 'turn.ended' && frame.agent_id === MAIN_AGENT_ID);
    const idleAt = channel.frames.findIndex(
      (frame, index) => index > 0 && frame.type === 'agent' && frame.agent_id === MAIN_AGENT_ID && frame.status === 'idle' && channel.frames.slice(0, index).some((f) => f.type === 'agent' && f.status === 'running'),
    );
    expect(turnEndedAt).toBeGreaterThanOrEqual(0);
    expect(idleAt).toBeGreaterThan(turnEndedAt);
    channel.close();
  });

  it('S2: a prompt submitted mid-turn runs as its own turn after the first', async () => {
    await boot([
      { match: (body) => body.includes('first prompt'), respond: () => sseText('first done'), delayMs: 2500 },
      { match: () => true, respond: () => sseText('second done') },
    ]);
    const sid = await createSession(server!, base);
    const first = await submitPrompt(server!, base, sid, 'first prompt');
    await until('first turn running', async () => (await getTurns(server!, base, sid)).turns.some((turn) => turn.status === 'running'));
    const second = await submitPrompt(server!, base, sid, 'second prompt');

    await until('both turns ended', async () => {
      const page = await getTurns(server!, base, sid);
      return page.turns.length === 2 && page.turns.every((turn) => turn.status === 'ended');
    }, 45000);
    const end = await getTurns(server!, base, sid);
    expect(end.turns.map((turn) => turn.items[0].prompt_ids)).toEqual([[first.prompt_id], [second.prompt_id]]);
  });

  it('undo removes a steered turn consistently over REST and WebSocket', async () => {
    await boot([
      { match: (body) => body.includes('steered request'), respond: () => sseText('answer after steer') },
      { match: (body) => body.includes('original request'), respond: () => sseText('answer before steer'), delayMs: 1500 },
    ]);
    const sid = await createSession(server!, base);
    await submitPrompt(server!, base, sid, 'original request');
    await until('original request reaches model', () => llm!.hits.length > 0);
    const channel = await subscribeConversation(server!, sid);
    try {
      const steer = await submitPrompt(server!, base, sid, 'steered request');
      await rest(server!, base, `/api/v1/sessions/${sid}/prompts/${steer.prompt_id}:steer`, { method: 'POST', body: {} });
      await idle(server!, base, sid);
      const before = await getTurns(server!, base, sid);
      expect(before.turns).toHaveLength(2);
      expect(JSON.stringify(before.turns[1])).toContain('answer after steer');
      const steerItem = before.turns[1].items.find((item: any) => item.type === 'user_message' && item.placement === 'opener');
      expect(steerItem?.prompt_ids).toContain(steer.prompt_id);
      const turnIds = before.turns.map((turn) => turn.turn_id);
      await until('steer reaches subscriber', () => JSON.stringify(channel.turns()).includes('answer after steer'));
      expect(channel.turns()).toEqual(before.turns);

      const pages = channel.conversation.filter((frame) => frame.type === 'turns').length;
      const undone = await rest<{ removed_turn_ids: string[] }>(server!, base, `/api/v1/sessions/${sid}:undo`, { method: 'POST', body: { turn_id: before.turns[0].turn_id } });
      expect(undone.removed_turn_ids).toEqual(turnIds);
      expect((await getTurns(server!, base, sid)).turns).toEqual([]);
      await until('removal reaches subscriber', () => channel.conversation.some((frame) => frame.type === 'turns.removed'));
      expect(channel.conversation.find((frame) => frame.type === 'turns.removed').turn_ids).toEqual(turnIds);
      expect(channel.conversation.filter((frame) => frame.type === 'turns').length).toBe(pages);
      expect(channel.turns()).toEqual([]);
      const reconnected = await subscribeConversation(server!, sid);
      try {
        expect(reconnected.snapshot().turns).toEqual([]);
      } finally {
        reconnected.close();
      }

      await submitPrompt(server!, base, sid, 'steered request');
      await idle(server!, base, sid);
      const resent = await getTurns(server!, base, sid);
      expect(resent.turns.map((turn) => textOf(turn.items[0]))).toEqual(['steered request']);
      expect(resent.turns[0].ordinal).toBe(before.turns[0].ordinal);
      expect(resent.turns[0].turn_id).not.toBe(before.turns[0].turn_id);
      await until('resent turn reaches subscriber', () => channel.turns().length === 1 && channel.turns()[0].status === 'ended');
      expect(channel.turns()).toEqual(resent.turns);

      await closeSessionById(server!.core.accessor, sid);
      const reopened = await getTurns(server!, base, sid);
      expect(reopened.turns).toEqual(resent.turns);
      await rest(server!, base, `/api/v1/sessions/${sid}:undo`, { method: 'POST', body: { turn_id: resent.turns[0].turn_id } });
      expect((await getTurns(server!, base, sid)).turns).toEqual([]);
    } finally {
      channel.close();
    }
  }, 30000);

  it('S3: a pending approval rides on the tool item, then resolves', async () => {
    await boot([
      { match: (body) => !body.includes('echo contract-hi'), respond: () => sseToolCall('call_1', 'Bash', '{"command":"echo contract-hi"}') },
      { match: () => true, respond: () => sseText('tool done') },
    ]);
    const sid = await createSession(server!, base);
    const channel = await subscribeConversation(server!, sid);
    await submitPrompt(server!, base, sid, 'run the echo', 'manual');

    const pendingApproval = () =>
      interactions
        .findAll({ kind: 'approval', resolved: false, tags: { sessionId: sid } })
        .find((item) => (item.payload as ApprovalRequest).toolName === 'Bash');
    await until('approval pending', async () => pendingApproval() !== undefined);
    await until('live tool item', () => channel.turns().some((turn) => turn.items.some((item: any) => item.item_id === 'call_1')));
    const approval = pendingApproval()!;

    await rest(server!, base, `/api/v1/sessions/${encodeURIComponent(sid)}/interactions/${encodeURIComponent(approval.id)}`, {
      method: 'POST',
      body: { kind: 'approval', decision: 'approved' },
    });
    await idle(server!, base, sid);

    const end = await getTurns(server!, base, sid);
    const [tool] = toolItems(end, 'Bash');
    expect(tool).toMatchObject({
      item_id: 'call_1',
      status: 'ended',
      outcome: 'completed',
      input: { command: 'echo contract-hi' },
      interaction_id: approval.id,
    });
    expect(tool).not.toHaveProperty('stage');
    expect(String(tool.output)).toContain('contract-hi');
    const toolFrames = channel.conversation.filter((frame) => frame.item?.item_id === 'call_1' || frame.item_id === 'call_1');
    expect(toolFrames[0]).toMatchObject({ type: 'item.started', item: { stage: 'input', name: 'Bash' } });
    expect(toolFrames).toContainEqual(expect.objectContaining({
      type: 'item.updated',
      set: expect.objectContaining({ stage: 'awaiting_approval', interaction_id: approval.id }),
    }));
    expect(toolFrames.filter((frame) => frame.type === 'item.ended')).toHaveLength(1);
    await until('turn ended on the channel', () => channel.turns()[0]?.status === 'ended');
    expect(channel.turns()).toEqual(end.turns);
    channel.close();
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
    const channel = await subscribeConversation(server!, sid);

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
      const page = await getTurns(server!, base, sid);
      return page.turns.some((turn) => turn.items[0]?.type === 'notification');
    }, 45000);
    await idleOrDump(server!, base, sid);

    const end = await getTurns(server!, base, sid);
    const notificationTurn = end.turns.find((turn) => turn.items[0]?.type === 'notification');
    expect(notificationTurn.items[0]).toMatchObject({
      type: 'notification',
      status: 'ended',
      notification_type: 'task.completed',
      severity: 'info',
      source: { kind: 'background_task', id: task.task_id },
      task_id: task.task_id,
      agent_id: task.child_agent_id,
    });
    expect(notificationTurn.items[0].title.length).toBeGreaterThan(0);
    expect(JSON.stringify(notificationTurn.items[0])).not.toContain('<notification');
    const [agentTool] = toolItems(end, 'Agent');
    expect(agentTool.agent_refs).toEqual([expect.objectContaining({ agent_id: task.child_agent_id, role: 'child' })]);
    await until('notification turn ended on the channel', () => channel.turns().length === end.turns.length && channel.turns().every((turn) => turn.status === 'ended'));
    expect(channel.turns()).toEqual(end.turns);
    channel.close();
  });

  it('S5: subscribing to a running turn shows what the step has streamed so far', async () => {
    await boot([{ match: () => true, respond: () => sseText('slow answer'), delayMs: 4000 }]);
    const sid = await createSession(server!, base);
    await submitPrompt(server!, base, sid, 'take your time');
    await until('turn running', async () => (await getTurns(server!, base, sid)).turns.some((turn) => turn.status === 'running'));

    const channel = await subscribeConversation(server!, sid);
    expect(channel.snapshot().turns).toEqual([expect.objectContaining({ status: 'running', turn_number: 0 })]);
    expect(channel.agents[0]).toMatchObject({ status: 'running' });
    await idle(server!, base, sid);
    await until('agent idle frame', () => channel.agents.at(-1)?.status === 'idle');
    await until('turn ended on the channel', () => channel.turns()[0]?.status === 'ended');
    expect(channel.turns()).toEqual((await getTurns(server!, base, sid)).turns);
    channel.close();
  });

  it('S6: the REST page and the WS turns frame agree', async () => {
    await boot([
      { match: (body) => !body.includes('echo s6'), respond: () => sseToolCall('call_s6', 'Bash', '{"command":"echo s6"}') },
      { match: () => true, respond: () => sseText('s6 done') },
    ]);
    const sid = await createSession(server!, base);
    await submitPrompt(server!, base, sid, 'run echo for s6');
    await idle(server!, base, sid);

    const page = await getTurns(server!, base, sid);
    const channel = await subscribeConversation(server!, sid);
    expect(channel.snapshot().turns).toEqual(page.turns);
    expect(channel.snapshot().has_more).toBe(page.has_more);
    expect(toolItems(page, 'Bash')).toEqual([expect.objectContaining({ item_id: 'call_s6', status: 'ended' })]);
    channel.close();
  });

  it('S10: a fresh session sends main agent frames on subscribe and a TodoList write reaches subscribers as a todo frame', async () => {
    const todos = '{"todos":[{"title":"write tests","status":"in_progress"},{"title":"ship","status":"pending"}]}';
    await boot([
      { match: (body) => !body.includes('call_todo'), respond: () => sseToolCall('call_todo', 'TodoList', todos) },
      { match: () => true, respond: () => sseText('planned') },
    ]);
    const sid = await createSession(server!, base);
    const channel = await subscribeConversation(server!, sid);
    await until('main agent frames', () => channel.agents.length > 0 && channel.todos.length > 0);
    expect(channel.agents[0]).toMatchObject({ type: 'agent', session_id: sid, status: 'idle' });
    expect(channel.todos[0]).toMatchObject({ type: 'todo', session_id: sid, items: [] });
    await submitPrompt(server!, base, sid, 'plan the work');
    await idleOrDump(server!, base, sid);
    await until('todo frame', () => (channel.todos.at(-1)?.items.length ?? 0) > 0);
    expect(channel.todos.at(-1)!.items).toEqual([
      { title: 'write tests', status: 'in_progress' },
      { title: 'ship', status: 'pending' },
    ]);
    channel.close();
  });

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
    }, { turnId: 0 });
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
    }, { turnId: 0 });
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
