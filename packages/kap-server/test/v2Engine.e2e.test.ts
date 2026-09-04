import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import {
  IProtocolAdapterRegistry,
  ProtocolAdapterRegistry,
  type IProtocolAdapterRegistry as IProtocolAdapterRegistryType,
  type ProtocolAdapterConfig,
  type StreamedMessagePart,
  type TokenUsage,
} from '@moonshot-ai/agent-core-v2';
import { startServer, type RunningServer } from '../src';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface ScriptedResponse {
  readonly parts: readonly StreamedMessagePart[];
  readonly finishReason?: string | null;
  readonly delays?: readonly number[];
}

const ZERO_USAGE: TokenUsage = { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };

function sleepAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    });
  });
}

class ScriptedStream {
  id: string | null = null;
  usage: TokenUsage | null = null;
  finishReason: string | null = null;
  rawFinishReason: string | null = null;

  constructor(
    private readonly response: ScriptedResponse,
    private readonly signal?: AbortSignal,
  ) {}

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    for (let i = 0; i < this.response.parts.length; i++) {
      const delay = this.response.delays?.[i] ?? 0;
      if (delay > 0) await sleepAbort(delay, this.signal);
      yield this.response.parts[i]!;
    }
    const hasToolCall = this.response.parts.some((p) => p.type === 'function');
    this.id = 'scripted';
    this.usage = { ...ZERO_USAGE, output: this.response.parts.length };
    this.finishReason = this.response.finishReason ?? (hasToolCall ? 'tool_calls' : 'completed');
    this.rawFinishReason = this.finishReason === 'completed' ? 'stop' : this.finishReason;
  }
}

class ScriptedChatProvider {
  readonly name = 'scripted';
  readonly modelName = 'scripted';
  readonly thinkingEffort = null;

  constructor(private readonly queue: ScriptedResponse[]) {}

  async generate(_systemPrompt?: unknown, _tools?: unknown, _history?: unknown, options?: { signal?: AbortSignal }): Promise<ScriptedStream> {
    const response = this.queue.shift();
    if (response === undefined) throw new Error('scriptedProvider: queue exhausted');
    return new ScriptedStream(response, options?.signal);
  }

  withThinking(): this {
    return this;
  }

  withMaxCompletionTokens(): this {
    return this;
  }
}

function createScriptedSeed(): {
  readonly seed: readonly [typeof IProtocolAdapterRegistry, IProtocolAdapterRegistryType];
  readonly push: (response: ScriptedResponse) => void;
} {
  const queue: ScriptedResponse[] = [];
  const provider = new ScriptedChatProvider(queue);
  const real = new ProtocolAdapterRegistry();
  const registry = {
    _serviceBrand: undefined,
    supportedProtocols: () => real.supportedProtocols(),
    resolveAdapterIdentity: real.resolveAdapterIdentity.bind(real),
    resolveProviderBaseId: real.resolveProviderBaseId.bind(real),
    resolveCapability: real.resolveCapability.bind(real),
    explainCapability: real.explainCapability.bind(real),
    createChatProvider: (_input: ProtocolAdapterConfig) => provider,
  } as unknown as IProtocolAdapterRegistryType;
  return {
    seed: [IProtocolAdapterRegistry, registry],
    push: (response) => queue.push(response),
  };
}

interface V2Conn {
  ws: WebSocket;
  frames: Record<string, unknown>[];
  next(predicate: (frame: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
  send(frame: unknown): void;
  close(): Promise<void>;
}

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function openV2(port: number): Promise<V2Conn> {
  const frames: Record<string, unknown>[] = [];
  const waiters: { predicate: (frame: Record<string, unknown>) => boolean; resolve: (frame: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v2/ws`, ['kimi-code.bearer.smoke']);
  const conn: V2Conn = {
    ws,
    frames,
    next: (predicate, timeoutMs = 30_000) =>
      new Promise((resolve, reject) => {
        const hit = frames.find(predicate);
        if (hit !== undefined) {
          resolve(hit);
          return;
        }
        const waiter = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            reject(new Error('v2 frame wait timeout'));
          }, timeoutMs),
        };
        waiters.push(waiter);
      }),
    send: (frame) => {
      ws.send(JSON.stringify(frame));
    },
    close: () =>
      new Promise((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        ws.on('close', () => {
          resolve();
        });
        ws.close();
      }),
  };
  ws.on('message', (data) => {
    const frame = JSON.parse(rawToString(data)) as Record<string, unknown>;
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i]!;
      if (waiter.predicate(frame)) {
        clearTimeout(waiter.timer);
        waiters.splice(i, 1);
        waiter.resolve(frame);
      }
    }
  });
  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      resolve(conn);
    });
    ws.on('error', reject);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function postJson<T>(port: number, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as Promise<T>;
}

async function getJson<T>(port: number, path: string): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return (await res.json()) as Promise<T>;
}

interface SessionWire {
  id: string;
}

function spine(frames: readonly Record<string, unknown>[], types: readonly string[]): boolean {
  let cursor = 0;
  for (const type of types) {
    let found = -1;
    for (let i = cursor; i < frames.length; i++) {
      if (frames[i]!['type'] === type) {
        found = i;
        break;
      }
    }
    if (found < 0) return false;
    cursor = found + 1;
  }
  return true;
}

describe('v2 stack 真实引擎 e2e', () => {
  let server: RunningServer;
  let scripted: ReturnType<typeof createScriptedSeed>;
  let port: number;
  let homeDir: string;
  let wsDir: string;

  beforeAll(async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-v2-engine-home-'));
    wsDir = mkdtempSync(join(tmpdir(), 'kimi-v2-engine-ws-'));
    writeFileSync(
      join(homeDir, 'config.toml'),
      [
        'default_model = "stub"',
        '',
        '[providers.stub]',
        'type = "openai"',
        'base_url = "http://127.0.0.1:9999"',
        'api_key = "stub"',
        '',
        '[models.stub]',
        'provider = "stub"',
        'model = "stub"',
        'max_context_size = 1000000',
        '',
      ].join('\n'),
    );
    scripted = createScriptedSeed();
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir,
      logLevel: 'silent',
      disableAuth: true,
      seeds: [scripted.seed],
    });
    port = server.port;
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(wsDir, { recursive: true, force: true });
  }, 60_000);

  it('(a) 纯文本 turn：basic 结构', async () => {
    const created = await postJson<{ data: SessionWire }>(port, '/api/v1/sessions', { metadata: { cwd: wsDir } });
    const sessionId = created.data.id;
    await postJson(port, `/api/v1/sessions/${sessionId}/profile`, { agent_config: { model: 'stub' } });
    const conn = await openV2(port);
    conn.send({ type: 'subscribe', id: 1, session_id: sessionId });
    const ack = await conn.next((f) => f['type'] === 'ack');
    expect(ack).toMatchObject({ id: 1, code: 0 });

    scripted.push({ parts: [{ type: 'think', think: '在打招呼' }, { type: 'text', text: '你好！' }, { type: 'text', text: '有什么可以帮你的？' }] });
    await postJson(port, `/api/v1/sessions/${sessionId}/prompts`, { content: [{ type: 'text', text: '你好' }] });
    await conn.next((f) => f['type'] === 'turn' && f['state'] === 'completed');
    await conn.next((f) => f['type'] === 'user' && f['status'] === 'completed');
    const idle = await conn.next((f) => f['type'] === 'session.state' && f['busy'] === false);

    const frames = conn.frames;
    expect(spine(frames, ['hello', 'ack', 'user', 'turn', 'session.state', 'step', 'thinking', 'thinking.delta', 'assistant', 'assistant.delta', 'assistant', 'step', 'turn', 'user', 'session.state'])).toBe(true);
    const turn = frames.find((f) => f['type'] === 'turn' && f['state'] === 'running')!;
    expect(turn).toMatchObject({ turn_id: 't1', ordinal: 0, user_message_id: 't1.u0', origin: { kind: 'user' } });
    const step = frames.find((f) => f['type'] === 'step')!;
    expect(step).toMatchObject({ step_id: 't1.0', turn_id: 't1' });
    const completed = frames.find((f) => f['type'] === 'assistant' && f['status'] === 'completed')!;
    expect(completed).toMatchObject({ message_id: 't1.0.a0', turn_id: 't1', step_id: 't1.0' });
    expect(String(completed['text'])).toBe('你好！有什么可以帮你的？');
    expect(idle).toMatchObject({ busy: false, main_turn_active: false, activity: 'idle' });
    await conn.close();
  }, 60_000);

  it('(b) Bash 工具 turn（yolo 免审批）：tool 结构', async () => {
    const created = await postJson<{ data: SessionWire }>(port, '/api/v1/sessions', { metadata: { cwd: wsDir } });
    const sessionId = created.data.id;
    await postJson(port, `/api/v1/sessions/${sessionId}/profile`, { agent_config: { model: 'stub', permission_mode: 'yolo' } });
    const conn = await openV2(port);
    conn.send({ type: 'subscribe', id: 1, session_id: sessionId });
    await conn.next((f) => f['type'] === 'ack');

    scripted.push({ parts: [{ type: 'function', id: 'call_b1', name: 'Bash', arguments: '{"command":"echo hello_from_bash"}' }] });
    scripted.push({ parts: [{ type: 'text', text: '已经跑完：输出 hello_from_bash。' }] });
    await postJson(port, `/api/v1/sessions/${sessionId}/prompts`, { content: [{ type: 'text', text: '跑一下 echo' }] });
    await conn.next((f) => f['type'] === 'turn' && f['state'] === 'completed');
    await conn.next((f) => f['type'] === 'session.state' && f['busy'] === false);

    const frames = conn.frames;
    expect(spine(frames, ['hello', 'ack', 'user', 'turn', 'step', 'tool_call', 'tool_call', 'step', 'step', 'assistant', 'step', 'turn', 'user'])).toBe(true);
    const callRunning = frames.find((f) => f['type'] === 'tool_call' && f['state'] === 'running')!;
    expect(callRunning).toMatchObject({ name: 'Bash', state: 'running', input: { command: 'echo hello_from_bash' } });
    const callDone = frames.find((f) => f['type'] === 'tool_call' && f['state'] === 'done')!;
    expect(callDone).toMatchObject({ name: 'Bash', state: 'done' });
    expect(JSON.stringify(callDone['output'])).toContain('hello_from_bash');
    const steps = frames.filter((f) => f['type'] === 'step' && f['state'] === 'completed');
    expect(steps.map((s) => s['finish_reason'])).toEqual(['tool_use', 'end_turn']);
    await conn.close();
  }, 60_000);

  it('(c) manual 权限 approval：interaction 全链路', async () => {
    const created = await postJson<{ data: SessionWire }>(port, '/api/v1/sessions', { metadata: { cwd: wsDir } });
    const sessionId = created.data.id;
    await postJson(port, `/api/v1/sessions/${sessionId}/profile`, { agent_config: { model: 'stub', permission_mode: 'manual' } });
    const conn = await openV2(port);
    conn.send({ type: 'subscribe', id: 1, session_id: sessionId });
    await conn.next((f) => f['type'] === 'ack');

    scripted.push({ parts: [{ type: 'function', id: 'call_c1', name: 'Bash', arguments: '{"command":"echo needs_approval"}' }] });
    scripted.push({ parts: [{ type: 'text', text: '批准后已执行：输出 needs_approval。' }] });
    await postJson(port, `/api/v1/sessions/${sessionId}/prompts`, { content: [{ type: 'text', text: '执行需要审批的命令' }] });
    const pending = await conn.next((f) => f['type'] === 'interaction' && f['state'] === 'pending');
    expect(pending).toMatchObject({ kind: 'approval', state: 'pending', tool_call_id: 'call_c1' });
    const approvalId = pending['interaction_id'] as string;
    expect(approvalId).toBeTruthy();
    const backlink = await conn.next((f) => f['type'] === 'tool_call' && f['approval_id'] !== undefined);
    expect(backlink).toMatchObject({ approval_id: approvalId, state: 'running' });
    const awaiting = await conn.next((f) => f['type'] === 'session.state' && f['pending_interaction'] === 'approval');
    expect(awaiting).toMatchObject({ pending_interaction: 'approval', phase: { kind: 'awaiting_approval' } });

    await postJson(port, `/api/v1/sessions/${sessionId}/approvals/${approvalId}`, { decision: 'approved' });
    const resolved = await conn.next((f) => f['type'] === 'interaction' && f['state'] === 'approved');
    expect(resolved).toMatchObject({ state: 'approved', response: { decision: 'approved' }, request: pending['request'] });
    await conn.next((f) => f['type'] === 'tool_call' && f['state'] === 'done');
    await conn.next((f) => f['type'] === 'turn' && f['state'] === 'completed');
    await conn.next((f) => f['type'] === 'session.state' && f['busy'] === false);

    const frames = conn.frames;
    expect(spine(frames, ['interaction', 'tool_call', 'session.state', 'interaction', 'session.state', 'tool_call', 'step', 'turn', 'user'])).toBe(true);
    await conn.close();
  }, 60_000);

  it('(d) TodoWrite：todo 实体与回链', async () => {
    const created = await postJson<{ data: SessionWire }>(port, '/api/v1/sessions', { metadata: { cwd: wsDir } });
    const sessionId = created.data.id;
    await postJson(port, `/api/v1/sessions/${sessionId}/profile`, { agent_config: { model: 'stub' } });
    const conn = await openV2(port);
    conn.send({ type: 'subscribe', id: 1, session_id: sessionId });
    await conn.next((f) => f['type'] === 'ack');

    const todos1 = [
      { title: '定位白屏原因', status: 'in_progress' },
      { title: '修复崩溃', status: 'pending' },
    ];
    const todos2 = [
      { title: '定位白屏原因', status: 'done' },
      { title: '修复崩溃', status: 'in_progress' },
    ];
    scripted.push({ parts: [{ type: 'function', id: 'call_d1', name: 'TodoList', arguments: JSON.stringify({ todos: todos1 }) }] });
    scripted.push({ parts: [{ type: 'function', id: 'call_d2', name: 'TodoList', arguments: JSON.stringify({ todos: todos2 }) }] });
    scripted.push({ parts: [{ type: 'text', text: '清单已更新，开始修复。' }] });
    await postJson(port, `/api/v1/sessions/${sessionId}/prompts`, { content: [{ type: 'text', text: '先建任务清单再修' }] });
    await conn.next((f) => f['type'] === 'turn' && f['state'] === 'completed');
    await conn.next((f) => f['type'] === 'session.state' && f['busy'] === false);

    const frames = conn.frames;
    const todoFrames = frames.filter((f) => f['type'] === 'todo');
    expect(todoFrames.length).toBe(2);
    const todoIds = new Set(todoFrames.map((f) => f['todo_id']));
    expect(todoIds.size).toBe(1);
    const todoId = [...todoIds][0];
    expect(todoId).toMatch(/^td_\d{2}$/);
    expect(todoFrames[0]).toMatchObject({ todo_id: todoId, items: todos1 });
    expect(todoFrames[1]).toMatchObject({ todo_id: todoId, items: todos2 });
    const todoCalls = frames.filter((f) => f['type'] === 'tool_call' && f['name'] === 'TodoWrite');
    expect(todoCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of todoCalls) expect(call['todo_id']).toBe(todoId);
    expect(spine(frames, ['tool_call', 'todo', 'tool_call', 'todo', 'assistant', 'step', 'turn', 'user'])).toBe(true);
    await conn.close();
  }, 60_000);

  it('(e) 中断：abort 结构与 system interruption', async () => {
    const created = await postJson<{ data: SessionWire }>(port, '/api/v1/sessions', { metadata: { cwd: wsDir } });
    const sessionId = created.data.id;
    await postJson(port, `/api/v1/sessions/${sessionId}/profile`, { agent_config: { model: 'stub' } });
    const conn = await openV2(port);
    conn.send({ type: 'subscribe', id: 1, session_id: sessionId });
    await conn.next((f) => f['type'] === 'ack');

    scripted.push({
      parts: [
        { type: 'text', text: '先列顶层目录，' },
        { type: 'text', text: '再按功能分组说明。' },
      ],
      delays: [0, 60_000],
      finishReason: 'completed',
    });
    await postJson(port, `/api/v1/sessions/${sessionId}/prompts`, { content: [{ type: 'text', text: '总结一下这个项目的目录结构' }] });
    await conn.next((f) => f['type'] === 'assistant.delta');
    await sleep(300);
    await postJson(port, `/api/v1/sessions/${sessionId}:abort`);
    const interrupted = await conn.next((f) => f['type'] === 'step' && f['state'] === 'interrupted', 20_000);
    const turnEnd = await conn.next((f) => f['type'] === 'turn' && f['state'] === 'completed', 20_000);
    const system = await conn.next((f) => f['type'] === 'system' && f['subtype'] === 'interruption');
    const userDone = await conn.next((f) => f['type'] === 'user' && f['status'] === 'completed');
    await conn.next((f) => f['type'] === 'session.state' && f['busy'] === false);

    const frames = conn.frames;
    expect(interrupted).toMatchObject({ step_id: 't1.0', state: 'interrupted' });
    expect(turnEnd).toMatchObject({ turn_id: 't1', state: 'completed' });
    expect(system).toMatchObject({ subtype: 'interruption', system_id: 'm_01', payload: { reason: 'aborted', turn_id: 't1' } });
    expect(userDone).toMatchObject({ message_id: 't1.u0', status: 'completed' });
    expect(spine(frames, ['step', 'turn', 'user', 'system'])).toBe(true);
    await conn.close();
  }, 90_000);

  it('(f) 刷新恢复：断线重连恢复载荷', async () => {
    const created = await postJson<{ data: SessionWire }>(port, '/api/v1/sessions', { metadata: { cwd: wsDir } });
    const sessionId = created.data.id;
    await postJson(port, `/api/v1/sessions/${sessionId}/profile`, { agent_config: { model: 'stub' } });
    const conn = await openV2(port);
    conn.send({ type: 'subscribe', id: 1, session_id: sessionId });
    await conn.next((f) => f['type'] === 'ack');

    scripted.push({
      parts: [
        { type: 'text', text: '建议加在入口的' },
        { type: 'text', text: '全局参数解析处：' },
        { type: 'text', text: '`src/cli.ts` 里注册 `--verbose`。' },
        { type: 'text', text: '日志模块读到标志后调到 debug。' },
      ],
      delays: [0, 0, 2500, 0],
    });
    await postJson(port, `/api/v1/sessions/${sessionId}/prompts`, { content: [{ type: 'text', text: '我想给 CLI 加一个全局 `--verbose` 选项，加在哪里比较合适？' }] });
    await conn.next((f) => f['type'] === 'assistant.delta', 20_000);
    await sleep(200);
    await conn.close();
    await sleep(600);

    const second = await openV2(port);
    second.send({ type: 'subscribe', id: 1, session_id: sessionId });
    const ack2 = await second.next((f) => f['type'] === 'ack');
    expect(ack2).toMatchObject({ id: 1, code: 0 });
    const recoveryTurn = await second.next((f) => f['type'] === 'turn' && f['state'] === 'running');
    const recoveryStep = await second.next((f) => f['type'] === 'step' && f['state'] === 'running');
    const recoveryText = await second.next((f) => f['type'] === 'assistant' && f['status'] === 'streaming');
    const recoveryState = await second.next((f) => f['type'] === 'session.state');

    expect(recoveryTurn).toMatchObject({ turn_id: 't1', state: 'running', user_message_id: 't1.u0' });
    expect(recoveryStep).toMatchObject({ step_id: 't1.0', state: 'running', turn_id: 't1' });
    expect(recoveryText).toMatchObject({ message_id: 't1.0.a0', status: 'streaming' });
    expect(String(recoveryText['text'])).toBe('建议加在入口的全局参数解析处：');
    expect(recoveryState).toMatchObject({ busy: true, main_turn_active: true, activity: 'turn', phase: { kind: 'running' } });

    const finalText = await second.next((f) => f['type'] === 'assistant' && f['status'] === 'completed', 60_000);
    expect(String(finalText['text'])).toContain('建议加在入口的全局参数解析处：');
    await second.next((f) => f['type'] === 'turn' && f['state'] === 'completed', 60_000);
    await second.next((f) => f['type'] === 'session.state' && f['busy'] === false, 20_000);
    await second.close();
  }, 120_000);

  it('(g) REST 历史：turn 完成后冷重建结构', async () => {
    const created = await postJson<{ data: SessionWire }>(port, '/api/v1/sessions', { metadata: { cwd: wsDir } });
    const sessionId = created.data.id;
    await postJson(port, `/api/v1/sessions/${sessionId}/profile`, { agent_config: { model: 'stub', permission_mode: 'yolo' } });
    const conn = await openV2(port);
    conn.send({ type: 'subscribe', id: 1, session_id: sessionId });
    await conn.next((f) => f['type'] === 'ack');
    scripted.push({ parts: [{ type: 'function', id: 'call_g1', name: 'Bash', arguments: '{"command":"ls"}' }] });
    scripted.push({ parts: [{ type: 'text', text: '当前目录内容如上。' }] });
    await postJson(port, `/api/v1/sessions/${sessionId}/prompts`, { content: [{ type: 'text', text: '执行一下 ls' }] });
    await conn.next((f) => f['type'] === 'turn' && f['state'] === 'completed');
    await conn.next((f) => f['type'] === 'user' && f['status'] === 'completed');
    await sleep(500);

    const page = await getJson<{ data: { session_id: string; items: Record<string, unknown>[]; has_more: boolean; in_flight: unknown } }>(
      port,
      `/api/v1/sessions/${sessionId}/history?page_size=50`,
    );
    expect(page.data.has_more).toBe(false);
    expect(page.data.in_flight).toBeNull();
    const items = page.data.items;
    expect(items.map((item) => item['type'])).toEqual(['turn', 'step', 'user', 'tool_call', 'step', 'assistant']);
    expect(items[0]).toMatchObject({ type: 'turn', turn_id: 't1', state: 'completed', user_message_id: 't1.u0' });
    expect(items[0]!['usage']).toBeDefined();
    expect(items[0]!['duration_ms']).toBeDefined();
    expect(items[1]).toMatchObject({ type: 'step', step_id: 't1.0', state: 'completed', finish_reason: 'tool_use' });
    expect(items[2]).toMatchObject({ type: 'user', message_id: 't1.u0', status: 'completed' });
    expect(items[3]).toMatchObject({ type: 'tool_call', tool_call_id: 'call_g1', name: 'Bash', state: 'done' });
    expect(items[5]).toMatchObject({ type: 'assistant', message_id: 't1.1.a0', status: 'completed' });
    await conn.close();
  }, 60_000);

  it('(h) v1 并存冒烟：v1 subscribe 正常收帧', async () => {
    const created = await postJson<{ data: SessionWire }>(port, '/api/v1/sessions', { metadata: { cwd: wsDir } });
    const sessionId = created.data.id;
    await postJson(port, `/api/v1/sessions/${sessionId}/profile`, { agent_config: { model: 'stub' } });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`, ['kimi-code.bearer.smoke']);
    const frames: Record<string, unknown>[] = [];
    ws.on('message', (data) => {
      frames.push(JSON.parse(rawToString(data)) as Record<string, unknown>);
    });
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    ws.send(JSON.stringify({ type: 'client_hello', id: 'h1', payload: { client_id: 'p5-smoke', subscriptions: [sessionId] } }));
    const ack = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('v1 ack timeout'));
      }, 10_000);
      const poll = setInterval(() => {
        const hit = frames.find((f) => f['type'] === 'ack');
        if (hit !== undefined) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve(hit);
        }
      }, 25);
    });
    expect(ack).toMatchObject({ id: 'h1' });

    scripted.push({ parts: [{ type: 'text', text: 'v1 也能收到这条。' }] });
    await postJson(port, `/api/v1/sessions/${sessionId}/prompts`, { content: [{ type: 'text', text: 'v1 冒烟' }] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('v1 event timeout'));
      }, 15_000);
      const poll = setInterval(() => {
        const hit = frames.find((f) => f['type'] === 'assistant.delta' || f['type'] === 'context.append_loop_event');
        if (hit !== undefined) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        }
      }, 25);
    });
    ws.close();
    await sleep(200);
  }, 60_000);
});
