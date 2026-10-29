import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ensureMainAgent,
  getLiveSessionById,
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentProfileService,
  IEventBus,
  interactions,
} from '@moonshot-ai/agent-core-v2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import {
  centralUsersPath,
  INTERNAL_CENTRAL_SERVER_FLAG_ENV,
  registerCentralUser,
} from '../src/services/auth/centralUsers';
import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const ALICE_TOKEN = 'alice-token-0123456789abcdef0123456789abcdef';
const BOB_TOKEN = 'bob-token-abcdef0123456789abcdef0123456789';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
}

interface MockLlm {
  readonly port: number;
  readonly close: () => Promise<void>;
}

function sseText(text: string): string {
  return [
    `data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

async function startMockLlm(): Promise<MockLlm> {
  const server: Server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseText('ok'));
      }, 2000);
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

function configToml(port: number): string {
  return [
    'default_model = "stub"',
    '',
    '[providers.stub]',
    'type = "openai"',
    `base_url = "http://127.0.0.1:${String(port)}"`,
    'api_key = "stub"',
    '',
    '[models.stub]',
    'provider = "stub"',
    'model = "stub"',
    'max_context_size = 100000',
    '',
  ].join('\n');
}

describe('internal central server M1', () => {
  let home: string;
  let server: RunningServer;
  let base: string;
  let mock: MockLlm;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-central-server-m1-'));
    mock = await startMockLlm();
    await writeFile(join(home, 'config.toml'), configToml(mock.port), 'utf8');
    await registerCentralUser({ homeDir: home, userId: 'alice', displayName: 'Alice', token: ALICE_TOKEN });
    await registerCentralUser({ homeDir: home, userId: 'bob', displayName: 'Bob', token: BOB_TOKEN });
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      env: { [INTERNAL_CENTRAL_SERVER_FLAG_ENV]: '1' },
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    if (server !== undefined) await server.close();
    if (mock !== undefined) await mock.close();
    if (home !== undefined) await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function call<T>(
    token: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extraHeaders,
      },
      ...(method === 'GET' ? {} : { body: body === undefined ? undefined : JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  function rawToString(data: RawData): string {
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
    return Buffer.from(data as ArrayBuffer).toString('utf8');
  }

  async function openCentralWs(token: string): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/ws`, [`kimi-code.bearer.${token}`]);
    await new Promise<void>((resolve, reject) => {
      ws.once('message', (data: RawData) => {
        try {
          const frame = JSON.parse(rawToString(data)) as { type: string };
          if (frame.type !== 'server_hello') reject(new Error('unexpected first frame'));
          else resolve();
        } catch (error) {
          reject(error);
        }
      });
      ws.once('error', reject);
    });
    return ws;
  }

  async function createSession(): Promise<string> {
    const { body } = await call<{ id: string }>(ALICE_TOKEN, 'POST', '/api/v1/sessions', {
      metadata: { cwd: home },
    });
    expect(body.code).toBe(0);
    const handle = getLiveSessionById(server.core.accessor, body.data.id);
    expect(handle).toBeDefined();
    await ensureMainAgent(handle!);
    await handle!.accessor.get(IAgentLifecycleService).handleOf('main')!.accessor.get(IAgentProfileService).setModel('stub');
    return body.data.id;
  }

  it('authenticates independent users and stores only token hashes', async () => {
    const usersFile = centralUsersPath(home);
    const raw = await readFile(usersFile, 'utf8');
    expect(raw).not.toContain(ALICE_TOKEN);
    expect(raw).not.toContain(BOB_TOKEN);
    expect(JSON.parse(raw)).toMatchObject({
      version: 1,
      users: [
        { user_id: 'alice', display_name: 'Alice' },
        { user_id: 'bob', display_name: 'Bob' },
      ],
    });
    if (process.platform !== 'win32') expect((await stat(usersFile)).mode & 0o777).toBe(0o600);

    const alice = await call<{ user_id: string; display_name: string }>(ALICE_TOKEN, 'GET', '/api/v1/auth/principal');
    const bob = await call<{ user_id: string; display_name: string }>(BOB_TOKEN, 'GET', '/api/v1/auth/principal');
    const spoofed = await call<{ user_id: string }>(ALICE_TOKEN, 'GET', '/api/v1/auth/principal', undefined, {
      'x-user-id': 'bob',
      'x-display-name': 'Bob',
    });
    const invalid = await call<null>('invalid-token', 'GET', '/api/v1/auth/principal');

    expect(alice.body.data).toEqual({ user_id: 'alice', display_name: 'Alice' });
    expect(bob.body.data).toEqual({ user_id: 'bob', display_name: 'Bob' });
    expect(spoofed.body.data.user_id).toBe('alice');
    expect(invalid.status).toBe(401);
    await expect(registerCentralUser({ homeDir: home, userId: 'local-server', displayName: 'Reserved' })).rejects.toThrow('reserved');
  });

  it('accepts independent user credentials across WebSocket reconnects', async () => {
    const alice = await openCentralWs(ALICE_TOKEN);
    expect(alice.readyState).toBe(WebSocket.OPEN);
    alice.close();
    const bob = await openCentralWs(BOB_TOKEN);
    expect(bob.readyState).toBe(WebSocket.OPEN);
    bob.close();
  });

  it('accepts concurrent prompts in service order with one active turn and authenticated attribution', async () => {
    const sid = await createSession();
    const session = getLiveSessionById(server.core.accessor, sid)!;
    const main = session.accessor.get(IAgentLifecycleService).handleOf('main')!;
    const loop = main.accessor.get(IAgentLoopService);
    const submit = vi.spyOn(loop, 'submit');
    const events: unknown[] = [];
    const subscription = main.accessor.get(IEventBus).subscribe((event) => {
      if (event.type.startsWith('prompt.') || event.type === 'turn.ended') events.push(event);
    });
    await call(ALICE_TOKEN, 'GET', `/api/v1/sessions/${sid}/transcript?agent_id=main`);

    const first = await call<{ prompt_id: string; status: string }>(ALICE_TOKEN, 'POST', `/api/v1/sessions/${sid}/prompts`, {
      prompt_id: 'p-first',
      content: [{ type: 'text', text: 'first' }],
    });
    expect(first.body.code).toBe(0);
    expect(first.body.data.status).toBe('running');
    await vi.waitFor(() => expect(loop.snapshot().state).toBe('running'));

    const [bob, alice] = await Promise.all([
      call<{ prompt_id: string; status: string; submitted_by: { user_id: string } }>(BOB_TOKEN, 'POST', `/api/v1/sessions/${sid}/prompts`, {
        prompt_id: 'p-bob',
          content: [{ type: 'text', text: 'bob' }],
      }),
      call<{ prompt_id: string; status: string; submitted_by: { user_id: string } }>(ALICE_TOKEN, 'POST', `/api/v1/sessions/${sid}/prompts`, {
        prompt_id: 'p-alice',
          content: [{ type: 'text', text: 'alice' }],
      }),
    ]);
    expect(bob.body.code).toBe(0);
    expect(alice.body.code).toBe(0);
    expect(bob.body.data.submitted_by.user_id).toBe('bob');
    expect(alice.body.data.submitted_by.user_id).toBe('alice');

    const acceptedOrder = submit.mock.calls.map((call) => call[0].meta?.promptId);
    expect(acceptedOrder).toHaveLength(3);
    expect(acceptedOrder[0]).toBe('p-first');
    expect(new Set(acceptedOrder)).toEqual(new Set(['p-first', 'p-bob', 'p-alice']));
    expect(loop.snapshot().queue.map((entry) => entry.meta?.promptId)).toEqual(acceptedOrder.slice(1));
    expect(loop.snapshot().activeTurnId).toBeTypeOf('number');

    const submittedEvents = events.filter((event) => (event as { type: string }).type === 'prompt.submitted') as Array<{
      promptId: string;
      actor: { userId: string };
    }>;
    expect(submittedEvents.map((event) => [event.promptId, event.actor.userId])).toEqual(
      acceptedOrder.map((promptId) => [promptId, promptId === 'p-bob' ? 'bob' : 'alice']),
    );

    const steerTarget = acceptedOrder[1]!;
    const steered = await call<{ steered: boolean; steered_by: { user_id: string } }>(BOB_TOKEN, 'POST', `/api/v1/sessions/${sid}/prompts:steer`, {
      prompt_ids: [steerTarget],
    });
    expect(steered.body.code).toBe(0);
    expect(steered.body.data.steered_by.user_id).toBe('bob');

    await vi.waitFor(() => {
      expect(events.some((event) => {
        const candidate = event as { type: string; promptIds?: string[] };
        return candidate.type === 'prompt.steered' && candidate.promptIds?.includes(steerTarget) === true;
      })).toBe(true);
    });
    const steerEvent = events.find((event) => (event as { type: string }).type === 'prompt.steered') as {
      actor: { userId: string };
    };
    expect(steerEvent.actor.userId).toBe('bob');

    const transcript = await call<{ prompts: Array<{ promptId: string; actor?: { userId: string }; steeredBy?: { userId: string } }> }>(
      ALICE_TOKEN,
      'GET',
      `/api/v1/sessions/${sid}/transcript?agent_id=main`,
    );
    const prompt = transcript.body.data.prompts.find((item) => item.promptId === 'p-first');
    expect(prompt?.actor?.userId).toBe('alice');
    expect(prompt?.steeredBy?.userId).toBe('bob');
    subscription.dispose();
  }, 15000);

  it('lets only the first approval and question responses win and records the actual resolver', async () => {
    const sid = await createSession();
    await call(ALICE_TOKEN, 'GET', `/api/v1/sessions/${sid}/transcript?agent_id=main`);
    const resolutions: Array<{ id: string; actor?: { userId: string } }> = [];
    const subscription = interactions.onDidResolve((event) => {
      resolutions.push({ id: event.id, actor: event.actor });
    });

    interactions.enqueue({
      id: 'approval-race',
      kind: 'approval',
      payload: { toolCallId: 'call-race', toolName: 'Bash', action: 'run', display: {} },
      tags: { sessionId: sid, agentId: 'main', toolCallId: 'call-race' },
    });
    const approvalResponses = await Promise.all([
      call<{ resolved_by?: { user_id: string } }>(ALICE_TOKEN, 'POST', `/api/v1/sessions/${sid}/interactions/approval-race`, {
        kind: 'approval',
        decision: 'approved',
      }),
      call<{ code: number; resolved_by?: { user_id: string } }>(BOB_TOKEN, 'POST', `/api/v1/sessions/${sid}/interactions/approval-race`, {
        kind: 'approval',
        decision: 'rejected',
      }),
    ]);
    const approvalWinner = approvalResponses.find((response) => response.body.code === 0)!;
    const approvalLoser = approvalResponses.find((response) => response.body.code !== 0)!;
    const approvalWinnerUser = approvalWinner === approvalResponses[0] ? 'alice' : 'bob';
    expect(approvalLoser.body.code).toBe(40902);
    expect(approvalWinner.body.data.resolved_by?.user_id).toBe(approvalWinnerUser);
    expect(resolutions.find((event) => event.id === 'approval-race')?.actor?.userId).toBe(approvalWinnerUser);

    interactions.enqueue({
      id: 'question-race',
      kind: 'question',
      payload: {
        toolCallId: 'question-race-call',
        questions: [{ question: 'Pick one', options: [{ label: 'Yes' }, { label: 'No' }] }],
      },
      tags: { sessionId: sid, agentId: 'main', toolCallId: 'question-race-call' },
    });
    const questionResponses = await Promise.all([
      call<{ resolved_by?: { user_id: string } }>(ALICE_TOKEN, 'POST', `/api/v1/sessions/${sid}/interactions/question-race`, {
        kind: 'question',
        answers: { q_0: { kind: 'single', option_id: 'opt_0_0' } },
      }),
      call<{ resolved_by?: { user_id: string } }>(BOB_TOKEN, 'POST', `/api/v1/sessions/${sid}/interactions/question-race`, {
        kind: 'question',
        answers: { q_0: { kind: 'single', option_id: 'opt_0_1' } },
      }),
    ]);
    const questionWinner = questionResponses.find((response) => response.body.code === 0)!;
    const questionLoser = questionResponses.find((response) => response.body.code !== 0)!;
    const questionWinnerUser = questionWinner === questionResponses[0] ? 'alice' : 'bob';
    expect(questionLoser.body.code).toBe(40902);
    expect(questionWinner.body.data.resolved_by?.user_id).toBe(questionWinnerUser);
    expect(resolutions.find((event) => event.id === 'question-race')?.actor?.userId).toBe(questionWinnerUser);

    const transcript = await call<{ interactions: Array<{ interactionId: string; resolvedBy?: { userId: string } }> }>(
      ALICE_TOKEN,
      'GET',
      `/api/v1/sessions/${sid}/transcript?agent_id=main`,
    );
    expect(transcript.body.data.interactions.find((item) => item.interactionId === 'approval-race')?.resolvedBy?.userId).toBe(approvalWinnerUser);
    expect(transcript.body.data.interactions.find((item) => item.interactionId === 'question-race')?.resolvedBy?.userId).toBe(questionWinnerUser);
    subscription();
  });
});
