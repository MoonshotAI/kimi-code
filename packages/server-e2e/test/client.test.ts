/**
 * Self-tests for `DaemonClient` against a live server at
 * `process.env.KIMI_SERVER_URL ?? http://127.0.0.1:58627`.
 *
 * Every test gates on a `daemonReachable()` check so CI / dev machines
 * without a running server stay green. Run a server (`pnpm dev:server` from
 * repo root) to exercise these locally.
 *
 * Coverage:
 *   1. HTTP envelope unwrap throws on `code !== 0`.
 *   2. WS handshake completes (server_hello + client_hello ack).
 *   3. Subscribe ack succeeds for a real session id.
 *   4. `waitForFrame` times out cleanly (no zombie waiters).
 *   5. Created session is observable via `getSession`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  ErrorCode,
  type FileMeta,
  type Message,
  type ModelCatalogItem,
  type ProviderCatalogItem,
  type Session,
  type SessionStatusResponse,
} from '@moonshot-ai/protocol';

import { DaemonClient, EnvelopeError } from '../src/index.js';
import { fetchWithReport } from '../src/report.js';
import { createCaseLogger, errorForLog } from './log.js';

const BASE_URL = process.env['KIMI_SERVER_URL'] ?? 'http://127.0.0.1:58627';
const PROMPT_TIMEOUT_MS = 120_000;

async function daemonReachable(): Promise<boolean> {
  try {
    const res = await fetchWithReport(`${BASE_URL}/api/v1/meta`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const reachable = await daemonReachable();
const describeLive = reachable ? describe : describe.skip;

let created: { client: DaemonClient; sid: string }[] = [];

afterEach(async () => {
  // Best-effort cleanup so reruns don't accumulate phantom sessions.
  for (const { client, sid } of created.splice(0)) {
    try {
      await client.archiveSession(sid);
    } catch {
      // ignore
    }
    try {
      await client.close();
    } catch {
      // ignore
    }
  }
});

describeLive('DaemonClient (live server required)', () => {
  it('throws EnvelopeError on code !== 0', async () => {
    const log = createCaseLogger('client: missing session envelope');
    const client = new DaemonClient({ baseUrl: BASE_URL });
    const sid = 'sess_does_not_exist_xxxxxxxx';
    log('request', { method: 'GET', path: `/api/v1/sessions/${sid}` });

    let caughtError: unknown;
    try {
      await client.getSession(sid);
    } catch (error) {
      caughtError = error;
    }
    if (caughtError === undefined) {
      throw new Error('expected getSession to reject for a missing session');
    }
    log('error response', errorForLog(caughtError));
    expect(caughtError).toBeInstanceOf(EnvelopeError);
  });

  it('completes handshake (server_hello + client_hello ack)', async () => {
    const log = createCaseLogger('client: ws handshake');
    const client = new DaemonClient({ baseUrl: BASE_URL });
    log('connect request', { url: `${BASE_URL.replace(/^http/, 'ws')}/api/v1/ws` });
    const hello = await client.connect();
    log('server hello', hello);
    expect(hello.heartbeat_ms).toBeGreaterThan(0);
    expect(typeof hello.ws_connection_id).toBe('string');
    await client.close();
    log('closed');
  });

  it('subscribes to a real session id', async () => {
    const log = createCaseLogger('client: subscribe real session');
    const client = new DaemonClient({ baseUrl: BASE_URL });
    const session = await client.createSession({ metadata: { cwd: process.cwd() } });
    created.push({ client, sid: session.id });
    log('created session', session);
    await client.connect();
    log('subscribe request', { type: 'subscribe', session_ids: [session.id] });
    await expect(client.subscribe(session.id)).resolves.toBeUndefined();
    log('subscribe accepted', { session_id: session.id });
  });

  it('waitForFrame times out cleanly', async () => {
    const log = createCaseLogger('client: waitForFrame timeout');
    const client = new DaemonClient({ baseUrl: BASE_URL });
    await client.connect();
    log('wait request', { frame_type: 'event.does.not.exist', timeout_ms: 100 });
    let caughtError: unknown;
    try {
      await client.waitForFrame((f) => f.type === 'event.does.not.exist', { timeoutMs: 100 });
    } catch (error) {
      caughtError = error;
    }
    if (caughtError === undefined) {
      throw new Error('expected waitForFrame to time out');
    }
    log('timeout error', errorForLog(caughtError));
    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toMatch(/waitForFrame timed out/);
    await client.close();
    log('closed');
  });

  it('created session is readable via getSession', async () => {
    const log = createCaseLogger('client: getSession round trip');
    const client = new DaemonClient({ baseUrl: BASE_URL });
    const session = await client.createSession({ metadata: { cwd: process.cwd() } });
    created.push({ client, sid: session.id });
    log('created session', session);
    const fetched = await client.getSession(session.id);
    log('fetched session', fetched);
    expect(fetched.id).toBe(session.id);
    expect(fetched.metadata.cwd).toBe(process.cwd());
  });

  it('forks a session through the action-suffix route', async () => {
    const log = createCaseLogger('client: fork action');
    const client = new DaemonClient({ baseUrl: BASE_URL });
    const source = await client.createSession({
      title: 'Source session',
      metadata: { cwd: process.cwd(), source: true },
    });
    created.push({ client, sid: source.id });
    log('source session', source);

    const forkRequest = {
      metadata: { child: true },
    };
    log('request', {
      method: 'POST',
      path: `/api/v1/sessions/${source.id}:fork`,
      body: forkRequest,
    });

    const fork = await client.forkSession(source.id, forkRequest);
    created.push({ client, sid: fork.id });
    log('response', fork);

    expect(fork.id).not.toBe(source.id);
    expect(fork.title).toBe('Fork: Source session');
    expect(fork.metadata).toMatchObject({
      cwd: process.cwd(),
      source: true,
      child: true,
    });

    const fetched = await client.getSession(fork.id);
    log('fetched fork session', fetched);
    expect(fetched.id).toBe(fork.id);
  });

  it(
    'compactSession prints empty-history errors and compacted history content',
    async () => {
      const log = createCaseLogger('client: compact empty history');
      const client = new DaemonClient({ baseUrl: BASE_URL });
      const session = await client.createSession({ metadata: { cwd: process.cwd() } });
      created.push({ client, sid: session.id });
      log('source session', session);

      const compactRequest = { instruction: '  focus on decisions  ' };
      log('request', {
        method: 'POST',
        path: `/api/v1/sessions/${session.id}:compact`,
        body: compactRequest,
      });

      let compactError: unknown;
      try {
        const result = await client.compactSession(session.id, compactRequest);
        log('response', result);
      } catch (error) {
        compactError = error;
      }
      if (compactError === undefined) {
        throw new Error('expected compactSession to reject for an empty-history session');
      }
      log('error response', errorForLog(compactError));

      expect(compactError).toMatchObject({
        code: ErrorCode.COMPACTION_UNABLE,
        reason: 'compaction.unable',
        data: null,
      });

      const successLog = createCaseLogger('client: compact populated history');
      const populated = await client.createSession({ metadata: { cwd: process.cwd() } });
      created.push({ client, sid: populated.id });
      successLog('source session', populated);

      await client.connect();
      await client.subscribe(populated.id);
      successLog('subscribe accepted', { session_id: populated.id });

      const promptResult = await client.submitAndWait(
        populated.id,
        {
          content: [
            {
              type: 'text',
              text: 'Remember this compact-test fact: the code word is BLUE. Reply with "OK".',
            },
          ],
        },
        { waitFor: 'prompt.completed', timeoutMs: PROMPT_TIMEOUT_MS },
      );
      successLog('seed prompt completed', {
        prompt_id: promptResult.prompt_id,
        user_message_id: promptResult.user_message_id,
        final_frame: frameForLog(promptResult.finalFrame),
      });

      const beforeCompact = await client.listMessages(populated.id, { page_size: 100 });
      successLog('messages before compact', beforeCompact);
      expect(beforeCompact.items.some((m) => m.role === 'user')).toBe(true);
      expect(beforeCompact.items.some((m) => m.role === 'assistant')).toBe(true);

      const populatedCompactRequest = {
        instruction: 'Preserve the compact-test code word and the fact that the assistant replied OK.',
      };
      successLog('request', {
        method: 'POST',
        path: `/api/v1/sessions/${populated.id}:compact`,
        body: populatedCompactRequest,
      });

      const completedPromise = client.waitForFrame(
        (f) => f.type === 'compaction.completed' && f.session_id === populated.id,
        { timeoutMs: PROMPT_TIMEOUT_MS },
      );
      const compactResponse = await client.compactSession(populated.id, populatedCompactRequest);
      successLog('rest response', compactResponse);
      const completedFrame = await completedPromise;
      successLog('compaction completed frame', frameForLog(completedFrame));

      const afterCompact = await client.listMessages(populated.id, { page_size: 100 });
      successLog('messages after compact', afterCompact);

      const compactedText = afterCompact.items
        .flatMap((m) => m.content)
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      successLog('compacted text content', { text: compactedText });

      expect(afterCompact.items.length).toBeGreaterThan(0);
      expect(compactedText.length).toBeGreaterThan(0);
    },
    PROMPT_TIMEOUT_MS + 30_000,
  );

  it(
    'undoSession removes the latest prompt and returns refreshed messages plus status',
    async () => {
      const log = createCaseLogger('client: undo action');
      const client = new DaemonClient({ baseUrl: BASE_URL });
      const session = await client.createSession({ metadata: { cwd: process.cwd() } });
      created.push({ client, sid: session.id });
      log('source session', session);

      await client.connect();
      await client.subscribe(session.id);
      log('subscribe accepted', { session_id: session.id });

      const keepPrompt = await client.submitAndWait(
        session.id,
        { content: [{ type: 'text', text: 'Remember KEEP. Reply with "OK".' }] },
        { waitFor: 'prompt.completed', timeoutMs: PROMPT_TIMEOUT_MS },
      );
      log('keep prompt completed', {
        prompt_id: keepPrompt.prompt_id,
        user_message_id: keepPrompt.user_message_id,
        final_frame: frameForLog(keepPrompt.finalFrame),
      });

      const undoPrompt = await client.submitAndWait(
        session.id,
        { content: [{ type: 'text', text: 'Remember UNDO-ME. Reply with "OK".' }] },
        { waitFor: 'prompt.completed', timeoutMs: PROMPT_TIMEOUT_MS },
      );
      log('undo prompt completed', {
        prompt_id: undoPrompt.prompt_id,
        user_message_id: undoPrompt.user_message_id,
        final_frame: frameForLog(undoPrompt.finalFrame),
      });

      const beforeUndo = await client.listMessages(session.id, { page_size: 100 });
      log('messages before undo', beforeUndo);
      expect(textFromMessages(beforeUndo.items)).toContain('UNDO-ME');

      const result = await client.undoSession(session.id, { count: 1, page_size: 100 });
      log('undo response', result);

      const afterText = textFromMessages(result.messages.items);
      expect(afterText).toContain('KEEP');
      expect(afterText).not.toContain('UNDO-ME');
      expect(result.messages.has_more).toBe(false);
      expect(result.status.context_tokens).toBeGreaterThanOrEqual(0);
    },
    PROMPT_TIMEOUT_MS * 2 + 30_000,
  );
});

describe('DaemonClient session action helpers', () => {
  it('forkSession posts the action-suffix route and unwraps the returned session', async () => {
    const log = createCaseLogger('client helper: forkSession');
    const calls: FetchCall[] = [];
    const fork = testSession({ id: 'sess_fork', title: 'Fork: Source session' });
    const client = new DaemonClient({
      baseUrl: 'http://server.example.test',
      fetchImpl: recordingFetch(okEnvelope(fork), calls),
    });

    const result = await client.forkSession('sess_source', {
      title: 'Custom fork',
      metadata: { child: true },
    });

    log('fetch calls', calls);
    log('unwrapped result', result);
    expect(result).toEqual(fork);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://server.example.test/api/v1/sessions/sess_source:fork');
    expect(calls[0]?.init.method).toBe('POST');
    expect(parseRecordedJsonBody(calls[0])).toEqual({
      title: 'Custom fork',
      metadata: { child: true },
    });
  });

  it('compactSession posts the action-suffix route and preserves error envelope details', async () => {
    const log = createCaseLogger('client helper: compactSession');
    const calls: FetchCall[] = [];
    const client = new DaemonClient({
      baseUrl: 'http://server.example.test',
      fetchImpl: recordingFetch(
        {
          code: ErrorCode.COMPACTION_UNABLE,
          msg: 'No prefix can be compacted.',
          data: null,
          request_id: 'req_test',
        },
        calls,
      ),
    });

    let caughtError: unknown;
    try {
      await client.compactSession('sess_source', { instruction: '  focus on decisions  ' });
    } catch (error) {
      caughtError = error;
    }
    if (caughtError === undefined) {
      throw new Error('expected compactSession to reject for a non-zero envelope');
    }

    log('fetch calls', calls);
    log('error response', errorForLog(caughtError));
    expect(caughtError).toMatchObject({
      code: ErrorCode.COMPACTION_UNABLE,
      reason: 'compaction.unable',
      requestId: 'req_test',
      data: null,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://server.example.test/api/v1/sessions/sess_source:compact');
    expect(calls[0]?.init.method).toBe('POST');
    expect(parseRecordedJsonBody(calls[0])).toEqual({
      instruction: '  focus on decisions  ',
    });
  });

  it('undoSession posts the action-suffix route and unwraps messages plus status', async () => {
    const log = createCaseLogger('client helper: undoSession');
    const calls: FetchCall[] = [];
    const message = testMessage({ id: 'msg_kept', session_id: 'sess_source' });
    const undoResponse = {
      messages: { items: [message], has_more: false },
      status: testSessionStatus(),
    };
    const client = new DaemonClient({
      baseUrl: 'http://server.example.test',
      fetchImpl: recordingFetch(okEnvelope(undoResponse), calls),
    });

    const result = await client.undoSession('sess_source', { count: 2, page_size: 25 });

    log('fetch calls', calls);
    log('unwrapped result', result);
    expect(result).toEqual(undoResponse);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://server.example.test/api/v1/sessions/sess_source:undo');
    expect(calls[0]?.init.method).toBe('POST');
    expect(parseRecordedJsonBody(calls[0])).toEqual({
      count: 2,
      page_size: 25,
    });
  });

  it('model catalog helpers call the catalog and action-suffix routes', async () => {
    const log = createCaseLogger('client helper: model catalog');
    const calls: FetchCall[] = [];
    const model = testModel({ model: 'kimi-code/kimi-for-coding' });
    const provider = testProvider({ id: 'kimi', models: [model.model] });
    const client = new DaemonClient({
      baseUrl: 'http://server.example.test',
      fetchImpl: recordingFetchSequence(
        [
          okEnvelope({
            ready: true,
            providers_count: 1,
            default_model: model.model,
            managed_provider: null,
          }),
          okEnvelope({ items: [model] }),
          okEnvelope({ default_model: model.model, model }),
          okEnvelope({ items: [provider] }),
          okEnvelope(provider),
        ],
        calls,
      ),
    });

    await expect(client.getAuth()).resolves.toMatchObject({ default_model: model.model });
    await expect(client.listModels()).resolves.toEqual({ items: [model] });
    await expect(client.setDefaultModel(model.model)).resolves.toEqual({
      default_model: model.model,
      model,
    });
    await expect(client.listProviders()).resolves.toEqual({ items: [provider] });
    await expect(client.getProvider('kimi')).resolves.toEqual(provider);

    log('fetch calls', calls);
    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ['GET', 'http://server.example.test/api/v1/auth'],
      ['GET', 'http://server.example.test/api/v1/models'],
      ['POST', 'http://server.example.test/api/v1/models/kimi-code%2Fkimi-for-coding:set_default'],
      ['GET', 'http://server.example.test/api/v1/providers'],
      ['GET', 'http://server.example.test/api/v1/providers/kimi'],
    ]);
    expect(parseRecordedJsonBody(calls[2])).toEqual({});
  });

  it('child-session and pending reverse-RPC helpers call recovery routes', async () => {
    const log = createCaseLogger('client helper: children + pending');
    const calls: FetchCall[] = [];
    const child = testSession({ id: 'sess_child', title: 'Child session' });
    const client = new DaemonClient({
      baseUrl: 'http://server.example.test',
      fetchImpl: recordingFetchSequence(
        [
          okEnvelope(child),
          okEnvelope({ items: [child], has_more: false }),
          okEnvelope({ items: [] }),
          okEnvelope({ items: [] }),
          okEnvelope({ dismissed: true, dismissed_at: '2026-06-09T00:00:00.000Z' }),
        ],
        calls,
      ),
    });

    await expect(
      client.createChild('sess_parent', {
        title: 'Child session',
        metadata: { topic: 'side-question' },
      }),
    ).resolves.toEqual(child);
    await expect(
      client.listChildren('sess_parent', { page_size: 5, status: 'idle' }),
    ).resolves.toEqual({ items: [child], has_more: false });
    await expect(client.listPendingApprovals('sess_parent')).resolves.toEqual({ items: [] });
    await expect(client.listPendingQuestions('sess_parent')).resolves.toEqual({ items: [] });
    await expect(client.dismissQuestion('sess_parent', 'question_1')).resolves.toEqual({
      dismissed: true,
      dismissed_at: '2026-06-09T00:00:00.000Z',
    });

    log('fetch calls', calls);
    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ['POST', 'http://server.example.test/api/v1/sessions/sess_parent/children'],
      ['GET', 'http://server.example.test/api/v1/sessions/sess_parent/children?page_size=5&status=idle'],
      ['GET', 'http://server.example.test/api/v1/sessions/sess_parent/approvals?status=pending'],
      ['GET', 'http://server.example.test/api/v1/sessions/sess_parent/questions?status=pending'],
      ['POST', 'http://server.example.test/api/v1/sessions/sess_parent/questions/question_1:dismiss'],
    ]);
    expect(parseRecordedJsonBody(calls[0])).toEqual({
      title: 'Child session',
      metadata: { topic: 'side-question' },
    });
    expect(parseRecordedJsonBody(calls[4])).toEqual({});
  });

  it('uploadFile posts multipart form data and deleteFile hits the file route', async () => {
    const log = createCaseLogger('client helper: file upload');
    const calls: FetchCall[] = [];
    const file = testFile({ id: 'file_png', name: 'tiny.png', media_type: 'image/png', size: 3 });
    const client = new DaemonClient({
      baseUrl: 'http://server.example.test',
      fetchImpl: recordingFetchSequence(
        [
          okEnvelope(file),
          okEnvelope({ deleted: true }),
        ],
        calls,
      ),
    });

    await expect(
      client.uploadFile({
        name: 'tiny.png',
        data: new Uint8Array([1, 2, 3]),
        mediaType: 'image/png',
        expiresInSec: 60,
      }),
    ).resolves.toEqual(file);
    await expect(client.deleteFile(file.id)).resolves.toEqual({ deleted: true });

    log('fetch calls', calls);
    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ['POST', 'http://server.example.test/api/v1/files'],
      ['DELETE', 'http://server.example.test/api/v1/files/file_png'],
    ]);
    const form = calls[0]?.init.body;
    expect(form).toBeInstanceOf(FormData);
    const upload = form as FormData;
    expect(upload.get('name')).toBe('tiny.png');
    expect(upload.get('expires_in_sec')).toBe('60');
    const filePart = upload.get('file');
    expect(filePart).toBeInstanceOf(Blob);
    expect((filePart as Blob).type).toBe('image/png');
    expect((filePart as Blob).size).toBe(3);
  });
});

interface FetchCall {
  url: string;
  init: RequestInit;
}

function recordingFetch(responseBody: unknown, calls: FetchCall[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({ url: fetchInputUrl(input), init: init ?? {} });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function recordingFetchSequence(responseBodies: unknown[], calls: FetchCall[]): typeof fetch {
  let index = 0;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({ url: fetchInputUrl(input), init: init ?? {} });
    const responseBody = responseBodies[Math.min(index, responseBodies.length - 1)];
    index++;
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function parseRecordedJsonBody(call: FetchCall | undefined): unknown {
  const body = call?.init.body;
  if (typeof body !== 'string') {
    throw new TypeError('expected recorded fetch body to be a JSON string');
  }
  return JSON.parse(body) as unknown;
}

function okEnvelope<T>(data: T): { code: 0; msg: string; data: T; request_id: string } {
  return { code: 0, msg: 'success', data, request_id: 'req_test' };
}

function frameForLog(frame: {
  type: string;
  seq?: number;
  session_id?: string;
  id?: string;
  code?: number;
  msg?: string;
  payload?: unknown;
}): Record<string, unknown> {
  return {
    type: frame.type,
    seq: frame.seq,
    session_id: frame.session_id,
    id: frame.id,
    code: frame.code,
    msg: frame.msg,
    payload: frame.payload,
  };
}

function testSession(overrides: Partial<Session> = {}): Session {
  const base: Session = {
    id: 'sess_example',
    workspace_id: 'wd_example_0123456789ab',
    title: 'Example session',
    created_at: '2026-06-09T00:00:00.000Z',
    updated_at: '2026-06-09T00:00:00.000Z',
    status: 'idle',
    metadata: { cwd: '/tmp/example-server-e2e' },
    agent_config: { model: '' },
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_cost_usd: 0,
      context_tokens: 0,
      context_limit: 0,
      turn_count: 0,
    },
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
  };
  return {
    ...base,
    ...overrides,
    metadata: { ...base.metadata, ...overrides.metadata },
  };
}

function testModel(overrides: Partial<ModelCatalogItem> = {}): ModelCatalogItem {
  return {
    provider: 'kimi',
    model: 'k2',
    display_name: 'Kimi K2',
    max_context_size: 131_072,
    ...overrides,
  };
}

function testProvider(overrides: Partial<ProviderCatalogItem> = {}): ProviderCatalogItem {
  return {
    id: 'kimi',
    type: 'kimi',
    base_url: 'https://api.example.test/v1',
    default_model: 'k2',
    has_api_key: true,
    status: 'connected',
    models: ['k2'],
    ...overrides,
  };
}

function testFile(overrides: Partial<FileMeta> = {}): FileMeta {
  return {
    id: 'file_example',
    name: 'example.txt',
    media_type: 'text/plain',
    size: 0,
    created_at: '2026-06-09T00:00:00.000Z',
    ...overrides,
  };
}

function testMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg_example',
    session_id: 'sess_example',
    role: 'user',
    content: [{ type: 'text', text: 'kept' }],
    created_at: '2026-06-09T00:00:00.000Z',
    ...overrides,
  };
}

function testSessionStatus(): SessionStatusResponse {
  return {
    status: 'idle',
    model: 'kimi-code/kimi-for-coding',
    thinking_level: 'off',
    permission: 'manual',
    plan_mode: false,
    swarm_mode: false,
    context_tokens: 0,
    max_context_tokens: 100,
    context_usage: 0,
  };
}

function textFromMessages(messages: Array<{ content: Array<{ type: string; text?: string }> }>): string {
  return messages
    .flatMap((message) => message.content)
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
}
