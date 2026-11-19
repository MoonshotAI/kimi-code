import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface Step {
  readonly reasoning?: readonly string[];
  readonly text?: readonly string[];
  readonly calls?: readonly ToolCall[];
  readonly finishReason?: string;
  readonly error?: { readonly status: number; readonly message: string };
  readonly delayMs?: number;
  readonly intervalMs?: number;
  readonly hold?: { readonly name: string; readonly afterChunks: number };
}

export const say = (text: string | readonly string[], options: { intervalMs?: number } = {}): Step =>
  ({ text: typeof text === 'string' ? [text] : text, ...options });
export const call = (name: string, args: Record<string, unknown>, text?: string): Step =>
  ({ calls: [{ name, args }], ...(text === undefined ? {} : { text: [text] }) });
export const bash = (command: string, options: { description?: string; timeout?: number; background?: boolean } = {}): Step =>
  call('Bash', {
    command,
    description: options.description ?? 'Run a command',
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.background === true ? { run_in_background: true } : {}),
  });
export const waitFor = (timeout: number): Step => call('WaitFor', { timeout });
export const agent = (prompt: string, subagentType = 'coder'): Step =>
  call('Agent', { prompt, description: 'helper task', subagent_type: subagentType });
export const batch = (...steps: readonly Step[]): Step => ({ calls: steps.flatMap(step => step.calls ?? []) });
export const httpError = (status: number, message = `stub error ${status}`): Step => ({ error: { status, message } });
export const after = (delayMs: number, step: Step): Step => ({ ...step, delayMs });
export const held = (name: string, step: Step, afterChunks = 0): Step => ({ ...step, hold: { name, afterChunks } });
export const finishWith = (finishReason: string, step: Step): Step => ({ ...step, finishReason });
export const think = (reasoning: string | readonly string[], step: Step = {}): Step =>
  ({ ...step, reasoning: typeof reasoning === 'string' ? [reasoning] : reasoning });

export interface ChatMessage {
  readonly role: string;
  readonly content?: string | readonly { readonly type?: string; readonly text?: string }[] | null;
  readonly tool_calls?: readonly { readonly id: string; readonly function: { readonly name: string; readonly arguments: string } }[];
  readonly tool_call_id?: string;
}

export const textOf = (content: ChatMessage['content']): string =>
  typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join('');

const REMINDER = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;
export const withoutReminders = (text: string): string => text.replace(REMINDER, '').trim();
export const remindersIn = (text: string): string[] => [...text.matchAll(REMINDER)].map(match => match[1]!.trim());

export interface ModelRequest {
  readonly index: number;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: Readonly<Record<string, unknown>>;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly string[];
  readonly step: Step | null;
  readonly aborted: boolean;
  readonly finished: boolean;
  readonly userTextsSinceReply: readonly string[];
  readonly remindersSinceReply: readonly string[];
  readonly texts: (role: string) => readonly string[];
}

export interface Hold {
  readonly name: string;
  readonly reached: (timeoutMs?: number) => Promise<ModelRequest>;
  readonly release: () => void;
  readonly fail: (status?: number) => void;
  readonly cut: () => void;
}

export interface ScriptedReply {
  readonly release: () => void;
}

export interface StubModel {
  readonly baseUrl: string;
  readonly script: (...steps: readonly Step[]) => void;
  readonly scriptFor: (firstUserText: string, ...steps: readonly Step[]) => void;
  readonly dropScript: () => void;
  readonly hold: (name: string) => Hold;
  readonly requests: () => readonly ModelRequest[];
  readonly request: (index: number) => ModelRequest;
  readonly waitForRequest: (index: number, timeoutMs?: number) => Promise<ModelRequest>;
  readonly aborts: () => number;
  readonly sideRequests: () => number;
  readonly sideBodies: () => readonly (readonly ChatMessage[])[];
  readonly sideReply: (text: string) => void;
  readonly heldTurns: () => number;
  readonly waitForHeldTurn: (timeoutMs?: number) => Promise<void>;
  readonly releaseTurns: () => void;
  readonly queueReply: (chunks: readonly string[], options?: { holdAfterFirstChunk?: boolean }) => ScriptedReply;
  readonly agentRequests: () => number;
  readonly close: () => Promise<void>;
}

export function messageProblems(messages: readonly ChatMessage[]): string[] {
  const problems: string[] = [];
  const pendingCalls = new Set<string>();
  messages.forEach((message, index) => {
    const text = textOf(message.content).trim();
    const where = `messages[${index}] (${message.role})`;
    if (message.role === 'user' && text === '') problems.push(`${where} is empty`);
    if (message.role === 'assistant' && text === '' && (message.tool_calls?.length ?? 0) === 0) problems.push(`${where} has neither text nor tool calls`);
    const previous = messages[index - 1];
    if (previous !== undefined && message.role === 'user' && previous.role === 'user' && textOf(previous.content) === textOf(message.content)) {
      problems.push(`${where} duplicates the previous user message`);
    }
    if (message.role === 'tool') {
      if (message.tool_call_id === undefined || !pendingCalls.delete(message.tool_call_id)) {
        problems.push(`${where} answers unknown tool call ${String(message.tool_call_id)}`);
      }
    } else if (pendingCalls.size > 0) {
      problems.push(`${where} arrives before the results of tool calls ${[...pendingCalls].join(', ')}`);
    }
    for (const toolCall of message.tool_calls ?? []) pendingCalls.add(toolCall.id);
  });
  for (const id of pendingCalls) problems.push(`tool call ${id} has no result`);
  return problems;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function sse(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created: 0, model: 'e2e', ...payload })}\n\n`;
}

function delta(value: Record<string, unknown>, finishReason: string | null = null): string {
  return sse({ choices: [{ index: 0, delta: value, finish_reason: finishReason }] });
}

const DEFAULT_INTERVAL_MS = 40;
const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' };

function deltasFor(step: Step, requestIndex: number): Record<string, unknown>[] {
  const deltas: Record<string, unknown>[] = [
    ...(step.reasoning ?? []).map(reasoning => ({ reasoning_content: reasoning })),
    ...(step.text ?? []).map(content => ({ content })),
  ];
  (step.calls ?? []).forEach((toolCall, index) => {
    deltas.push({ tool_calls: [{ index, id: `call_e2e_${requestIndex}_${index}`, type: 'function', function: { name: toolCall.name, arguments: '' } }] });
    deltas.push({ tool_calls: [{ index, function: { arguments: JSON.stringify(toolCall.args) } }] });
  });
  if (deltas.length > 0) deltas[0] = { role: 'assistant', ...deltas[0] };
  return deltas;
}

type HoldOutcome = { kind: 'release' } | { kind: 'fail'; status: number } | { kind: 'cut' };

interface HoldState {
  afterChunks: number | null;
  request: RequestState | null;
  outcome: HoldOutcome | null;
  wake: (() => void) | null;
  readonly reachedWaiters: Set<(request: ModelRequest) => void>;
}

interface RequestState extends ModelRequest {
  aborted: boolean;
  finished: boolean;
  cut: boolean;
}

const failAfterFirstChunk = (name: string, afterChunks: number, status: number): Error =>
  new Error(`Hold "${name}" pauses after ${afterChunks} streamed chunk(s), so the HTTP 200 headers are already sent and fail(${status}) cannot send an error status; hold before the first chunk to fail, or use cut() to drop the stream mid-way`);

export class StubModelClosedError extends Error {
  constructor() {
    super('The stub model was closed before the awaited request arrived');
    this.name = 'StubModelClosedError';
  }
}

export async function startStubModel(): Promise<StubModel> {
  const heldResponses = new Set<ServerResponse>();
  const heldWaiters = new Set<() => void>();
  const steps: Step[] = [];
  const routes: Array<{ readonly key: string; readonly steps: Step[] }> = [];
  const records: RequestState[] = [];
  const requestWaiters = new Set<() => void>();
  const holds = new Map<string, HoldState>();
  let sideRequests = 0;
  const sideBodies: ChatMessage[][] = [];
  const sideReplies: string[] = [];
  let queuedReplies = 0;
  let closed = false;
  const pendingPauses = new Set<() => void>();
  const openWaits = new Set<(error: Error) => void>();

  const pause = (ms: number, response: ServerResponse): Promise<void> => new Promise<void>((resolve) => {
    if (closed || response.destroyed) { resolve(); return; }
    const done = (): void => {
      clearTimeout(timer);
      response.off('close', done);
      pendingPauses.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    response.once('close', done);
    pendingPauses.add(done);
  });

  const gone = (response: ServerResponse): boolean => closed || response.destroyed;

  const holdState = (name: string): HoldState => {
    let state = holds.get(name);
    if (state === undefined) {
      state = { afterChunks: null, request: null, outcome: null, wake: null, reachedWaiters: new Set() };
      holds.set(name, state);
    }
    return state;
  };

  const settleHold = (state: HoldState, outcome: HoldOutcome): void => {
    state.outcome ??= outcome;
    state.wake?.();
  };

  const waitAtHold = async (state: HoldState, record: RequestState): Promise<HoldOutcome> => {
    state.request = record;
    for (const notify of state.reachedWaiters) notify(record);
    state.reachedWaiters.clear();
    for (const wake of heldWaiters) wake();
    if (state.outcome === null) await new Promise<void>(resolve => { state.wake = resolve; });
    return state.outcome!;
  };

  const respondError = (response: ServerResponse, status: number, message: string): void => {
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message, type: 'stub_error', code: status } }));
  };

  const play = async (response: ServerResponse, record: RequestState, step: Step): Promise<void> => {
    if (step.delayMs !== undefined) await pause(step.delayMs, response);
    if (step.error !== undefined) {
      if (!gone(response)) respondError(response, step.error.status, step.error.message);
      return;
    }
    const deltas = deltasFor(step, record.index);
    const finishReason = step.finishReason ?? ((step.calls?.length ?? 0) > 0 ? 'tool_calls' : 'stop');
    const hold = step.hold === undefined ? null : holdState(step.hold.name);
    for (let index = 0; index <= deltas.length; index += 1) {
      if (gone(response)) return;
      if (hold !== null && index === step.hold!.afterChunks) {
        const outcome = await waitAtHold(hold, record);
        if (gone(response)) return;
        if (outcome.kind === 'fail' && !response.headersSent) {
          respondError(response, outcome.status, `stub error ${outcome.status}`);
          return;
        }
        if (outcome.kind !== 'release') {
          record.cut = true;
          response.destroy();
          return;
        }
      }
      if (index === deltas.length) break;
      if (!response.headersSent) response.writeHead(200, SSE_HEADERS);
      response.write(delta(deltas[index]!));
      if (index < deltas.length - 1) await pause(step.intervalMs ?? DEFAULT_INTERVAL_MS, response);
    }
    if (gone(response)) return;
    if (!response.headersSent) response.writeHead(200, SSE_HEADERS);
    response.write(delta({}, finishReason));
    response.write(sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    response.end('data: [DONE]\n\n');
  };

  const finishHeld = (response: ServerResponse): void => {
    if (response.writableEnded) return;
    response.write(delta({}, 'stop'));
    response.end('data: [DONE]\n\n');
  };

  const server = createServer((request, response) => {
    void readBody(request).then((body) => {
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
        response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
        return;
      }
      const payload = JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }>; messages?: ChatMessage[] };
      const tools = (payload.tools ?? []).map(tool => tool.function?.name ?? '');
      if (tools.length === 0) {
        sideRequests += 1;
        sideBodies.push(payload.messages ?? []);
        response.writeHead(200, SSE_HEADERS);
        response.write(delta({ role: 'assistant', content: sideReplies.shift() ?? 'Working on it' }));
        finishHeld(response);
        return;
      }
      const messages = payload.messages ?? [];
      const sinceReply = messages.slice(messages.findLastIndex(message => message.role === 'assistant') + 1);
      const sinceUser = sinceReply.filter(message => message.role === 'user').map(message => textOf(message.content));
      const firstUser = withoutReminders(textOf(messages.find(message => message.role === 'user')?.content));
      const route = routes.find(entry => firstUser.includes(entry.key));
      const step = (route === undefined ? steps.shift() : route.steps.shift()) ?? null;
      const record: RequestState = {
        index: records.length,
        path: request.url,
        authorization: request.headers.authorization,
        body: payload,
        messages,
        tools,
        step,
        aborted: false,
        finished: false,
        cut: false,
        userTextsSinceReply: sinceUser.map(withoutReminders).filter(text => text !== ''),
        remindersSinceReply: sinceUser.flatMap(remindersIn),
        texts: role => messages.filter(message => message.role === role).map(message => textOf(message.content)),
      };
      records.push(record);
      response.on('close', () => {
        heldResponses.delete(response);
        if (response.writableFinished) record.finished = true;
        else if (!record.cut) record.aborted = true;
      });
      for (const wake of requestWaiters) wake();
      if (step !== null) {
        void play(response, record, step);
        return;
      }
      response.writeHead(200, SSE_HEADERS);
      response.write(delta({ role: 'assistant', content: 'Working on it' }));
      heldResponses.add(response);
      for (const wake of heldWaiters) wake();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const timedWait = <T>(timeoutMs: number, message: () => string, subscribe: (settle: (value: T) => void) => () => void): Promise<T> => {
    let cancel: (error: Error) => void = () => undefined;
    const promise = new Promise<T>((resolve, reject) => {
      if (closed) { reject(new StubModelClosedError()); return; }
      let unsubscribe = (): void => undefined;
      let settled = false;
      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        openWaits.delete(cancel);
        return true;
      };
      const timer = setTimeout(() => { if (finish()) reject(new Error(message())); }, timeoutMs);
      cancel = (error) => {
        if (!finish()) return;
        promise.catch(() => undefined);
        reject(error);
      };
      openWaits.add(cancel);
      unsubscribe = subscribe((value) => { if (finish()) resolve(value); });
    });
    return promise;
  };

  const waitUntil = (ready: () => boolean, waiters: Set<() => void>, timeoutMs: number, message: () => string): Promise<void> =>
    ready() ? Promise.resolve() : timedWait<void>(timeoutMs, message, (settle) => {
      const wake = (): void => { if (ready()) settle(); };
      waiters.add(wake);
      return () => { waiters.delete(wake); };
    });

  const addSteps = (added: readonly Step[], target: Step[] = steps): void => {
    for (const step of added) {
      if (step.hold === undefined) continue;
      const state = holdState(step.hold.name);
      if (state.afterChunks !== null) throw new Error(`Hold "${step.hold.name}" is already used by another scripted step; give every held() step its own name`);
      state.afterChunks = step.hold.afterChunks;
      if (state.outcome?.kind === 'fail' && state.afterChunks > 0) throw failAfterFirstChunk(step.hold.name, state.afterChunks, state.outcome.status);
    }
    target.push(...added);
  };

  const scriptedHeldTurns = (): number =>
    [...holds.values()].filter(state => state.request !== null && state.outcome === null && !state.request.aborted).length;

  const heldTurns = (): number => heldResponses.size + scriptedHeldTurns();

  const releaseEverything = (): void => {
    for (const state of holds.values()) settleHold(state, { kind: 'release' });
    for (const response of heldResponses) finishHeld(response);
    heldResponses.clear();
  };

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    script: (...added) => { addSteps(added); },
    dropScript: () => { steps.length = 0; },
    scriptFor: (key, ...added) => {
      let route = routes.find(entry => entry.key === key);
      if (route === undefined) {
        route = { key, steps: [] };
        routes.push(route);
      }
      addSteps(added, route.steps);
    },
    hold: (name) => {
      const state = holdState(name);
      return {
        name,
        reached: (timeoutMs = 30_000) => state.request !== null
          ? Promise.resolve(state.request)
          : timedWait<ModelRequest>(timeoutMs, () => `No stub model request reached hold "${name}" within ${timeoutMs} ms`, (settle) => {
            state.reachedWaiters.add(settle);
            return () => { state.reachedWaiters.delete(settle); };
          }),
        release: () => settleHold(state, { kind: 'release' }),
        fail: (status = 500) => {
          if (state.afterChunks !== null && state.afterChunks > 0) {
            throw failAfterFirstChunk(name, state.afterChunks, status);
          }
          settleHold(state, { kind: 'fail', status });
        },
        cut: () => settleHold(state, { kind: 'cut' }),
      };
    },
    requests: () => records,
    request: (index) => {
      const record = records[index];
      if (record === undefined) throw new Error(`The stub model has received ${records.length} agent requests; request ${index} does not exist`);
      return record;
    },
    waitForRequest: async (index, timeoutMs = 30_000) => {
      await waitUntil(() => records.length > index, requestWaiters, timeoutMs, () => `The stub model received ${records.length} agent requests within ${timeoutMs} ms; expected request ${index}`);
      return records[index]!;
    },
    aborts: () => records.filter(record => record.aborted).length,
    sideRequests: () => sideRequests,
    sideBodies: () => sideBodies,
    sideReply: (text) => { sideReplies.push(text); },
    heldTurns,
    waitForHeldTurn: (timeoutMs = 30_000) =>
      waitUntil(() => heldTurns() > 0, heldWaiters, timeoutMs, () => `The stub model received no agent turn within ${timeoutMs} ms`),
    queueReply: (chunks, options = {}) => {
      if (options.holdAfterFirstChunk !== true) {
        addSteps([say(chunks)]);
        return { release: () => undefined };
      }
      queuedReplies += 1;
      const name = `queued-reply-${queuedReplies}`;
      addSteps([held(name, say(chunks), 1)]);
      const state = holdState(name);
      return { release: () => settleHold(state, { kind: 'release' }) };
    },
    agentRequests: () => records.length,
    releaseTurns: releaseEverything,
    close: async () => {
      closed = true;
      for (const done of [...pendingPauses]) done();
      for (const cancel of openWaits) cancel(new StubModelClosedError());
      releaseEverything();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

export type PermissionMode = 'manual' | 'auto' | 'yolo';

export function stubModelConfig(baseUrl: string, permissionMode?: PermissionMode): string {
  return [
    'default_model = "e2e/stub"',
    ...(permissionMode === undefined ? [] : [`default_permission_mode = "${permissionMode}"`]),
    '',
    '[providers.e2e]',
    'type = "openai"',
    `base_url = "${baseUrl}"`,
    'api_key = "sk-e2e"',
    '',
    '[models."e2e/stub"]',
    'provider = "e2e"',
    'model = "stub"',
    'max_context_size = 128000',
    '',
  ].join('\n');
}
