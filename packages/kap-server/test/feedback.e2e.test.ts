import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeSessionById, IOAuthService, ISessionExportService, MAIN_AGENT_ID, sessionDirOf } from '@moonshot-ai/agent-core-v2';
import { FileTokenStorage, OAuthUnauthorizedError, resolveKimiCodeOAuthRef, resolveKimiTokenStorageName } from '@moonshot-ai/kimi-code-oauth';
import { deferred } from '@moonshot-ai/testkit/fixtures';
import { agent, createFakeModel, held, say, type ReplyStep } from '@moonshot-ai/testkit/model';
import { afterAll, afterEach, assert, beforeAll, describe, expect, it, type TestContext, vi } from 'vitest';

import { ErrorCode } from '../src/protocol/error-codes';
import { FeedbackGateway, readFeedbackFile } from '../src/services/feedback/feedbackService';
import type { HostSession } from '../src/services/hosts/hostSession';
import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const token = 'test-feedback-access-token';

it('sends feedback to the configured managed deployment with its scoped OAuth credentials', async ({ onTestFinished }) => {
  const baseUrl = 'https://api.example.test/coding/v1';
  const oauthHost = 'https://auth.example.test';
  const ref = resolveKimiCodeOAuthRef({ baseUrl, oauthHost });
  const home = await mkdtemp(join(tmpdir(), 'kimi-feedback-deployment-'));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'config.toml'), `[providers."managed:kimi-code"]
type = "kimi"
base_url = "${baseUrl}"
oauth = { storage = "file", key = "${ref.key}", oauth_host = "${oauthHost}" }
`);
  await new FileTokenStorage(join(home, 'credentials')).save(resolveKimiTokenStorageName({ oauthKey: ref.key }), {
    accessToken: token, refreshToken: 'test-refresh', expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    expiresIn: 3_600, scope: '', tokenType: 'Bearer',
  });
  vi.stubEnv('KIMI_CODE_BASE_URL', undefined);
  vi.stubEnv('KIMI_CODE_FEEDBACK_BASE_URL', undefined);
  vi.stubEnv('KIMI_OAUTH_HOST', undefined);
  onTestFinished(() => { vi.unstubAllEnvs(); });
  const requests = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== `${baseUrl}/feedback`) throw new Error('Unexpected outbound request');
    if (request.headers.get('authorization') !== `Bearer ${token}`) return new Response(null, { status: 401 });
    return Response.json({ feedback_id: 17 });
  });
  onTestFinished(() => { requests.mockRestore(); });
  const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent', skipInstanceRegistry: true });
  onTestFinished(() => server.close());
  const result = await server.app.inject({
    method: 'POST', url: '/api/v1/feedback', headers: authHeaders(server),
    payload: { kind: 'global', source: 'sidebar', category: 'bug', content: 'Deployment feedback' },
  });
  expect(result.json()).toMatchObject({ code: 0, data: { feedback_id: 17 } });
});

function withRequestId(id: string, step: ReplyStep): ReplyStep {
  return { ...step, headers: { 'x-request-id': id } };
}

describe('desktop feedback', () => {
  let server: RunningServer;
  let home: string;
  let gatewayOrigin: string;
  let signedIn = true;
  let lastFeedbackId = 0;
  let lastUploadId = 0;
  const ownedFeedback = new Set<number>();
  const uploads = new Map<number, Record<string, unknown>>();
  const signedMethods = new Map<number, string>();
  const receivedParts = new Map<number, { method: string; bytes: Buffer }>();
  const created: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const completed: Record<string, unknown>[] = [];
  const model = createFakeModel();
  const managed = model.route('managed', req => req.path.startsWith('/managed/'));
  const gateway = createServer((req, res) => {
    void handleGateway(req, res).catch(() => {
      res.writeHead(500).end();
    });
  });

  async function handleGateway(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    const path = req.url ?? '';
    if (path.startsWith('/storage/') && (req.method === 'PUT' || req.method === 'POST')) {
      if (req.headers.authorization !== undefined) {
        res.writeHead(403).end();
        return;
      }
      receivedParts.set(Number(path.split('/').at(-1)), { method: req.method, bytes: data });
      res.writeHead(200, { etag: '"test-etag"' }).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }

    const body = JSON.parse(data.toString()) as Record<string, unknown>;
    res.setHeader('content-type', 'application/json');
    if (path === '/coding/v1/feedback') {
      created.push(body);
      ownedFeedback.add(++lastFeedbackId);
      res.end(JSON.stringify({ feedback_id: lastFeedbackId }));
    } else if (path === '/coding/v1/feedback/update') {
      if (!ownedFeedback.has(Number(body['feedback_id']))) {
        res.writeHead(409).end(JSON.stringify({ message: 'not owned or expired' }));
        return;
      }
      updates.push(body);
      res.end('{}');
    } else if (path === '/coding/v1/feedback/upload_url') {
      if (!ownedFeedback.has(Number(body['feedback_id']))) {
        res.writeHead(409).end(JSON.stringify({ message: 'not owned or expired' }));
        return;
      }
      const id = ++lastUploadId;
      uploads.set(id, body);
      res.end(JSON.stringify({
        upload: {
          id,
          parts: [{ part_number: 1, url: `${gatewayOrigin}/storage/${id}`, size: body['file_size'], method: signedMethods.get(Number(body['feedback_id'])) }],
        },
      }));
    } else if (path === '/coding/v1/feedback/upload_complete') {
      completed.push(body);
      res.end('{}');
    } else {
      res.writeHead(404).end();
    }
  }

  beforeAll(async () => {
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    const address = gateway.address();
    if (address === null || typeof address === 'string') throw new Error('No test gateway port.');
    gatewayOrigin = `http://127.0.0.1:${address.port}`;
    await model.listen();
    const managedBaseUrl = `${model.origin}/managed/v1`;
    vi.stubEnv('KIMI_CODE_BASE_URL', managedBaseUrl);
    vi.stubEnv('KIMI_CODE_FEEDBACK_BASE_URL', `${gatewayOrigin}/coding/v1/`);
    vi.stubEnv('KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START', '0');
    vi.stubEnv('KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS', '0');
    home = await mkdtemp(join(tmpdir(), 'kimi-feedback-test-'));
    await writeFile(join(home, 'config.toml'), `default_model = "stub"

[providers.stub]
type = "openai"
base_url = "${model.baseUrl}"
api_key = "test-model-key"

[models.stub]
provider = "stub"
model = "stub"
max_context_size = 100000

[models.alternate]
provider = "alternate-provider"
model = "different-model"
max_context_size = 100000

[providers.alternate-provider]
type = "openai"
base_url = "${managedBaseUrl}"
api_key = "test-model-key"

[secondary_model]
default_model = "alternate"
`);
    const oauth: IOAuthService = {
      _serviceBrand: undefined,
      startLogin: async () => { throw new Error('Unexpected OAuth login.'); },
      getFlow: () => undefined,
      cancelLogin: async () => { throw new Error('Unexpected OAuth cancellation.'); },
      logout: async () => { throw new Error('Unexpected OAuth logout.'); },
      status: async () => ({ loggedIn: signedIn }),
      refreshOAuthProviderModels: async () => ({ changed: [], unchanged: [], failed: [] }),
      getManagedUsage: async () => ({ kind: 'error', message: 'Unavailable in this test.' }),
      getManagedUserInfo: async () => ({ kind: 'error', message: 'Unavailable in this test.' }),
      resolveTokenProvider: () => ({
        getAccessToken: async () => {
          if (!signedIn) throw new OAuthUnauthorizedError('Not signed in.');
          return token;
        },
      }),
      getCachedAccessToken: async () => signedIn ? token : undefined,
      getRegion: () => 'mainland-cn',
      getRegionAsync: async () => 'mainland-cn',
    };
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [[IOAuthService, oauth]],
    });
  });

  afterEach(() => model.verify());

  afterAll(async () => {
    await server?.close();
    await model.close();
    await new Promise<void>((resolve, reject) => {
      gateway.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
    if (home !== undefined) await rm(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function request<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ code: number; data: T }> {
    const multipart = body instanceof FormData;
    const response = await fetch(`http://127.0.0.1:${server.port}/api/v1${path}`, {
      method,
      headers: authHeaders(server, { ...headers, ...(multipart || body === undefined ? {} : { 'content-type': 'application/json' }) }),
      body: multipart ? body : body === undefined ? undefined : JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return await response.json() as { code: number; data: T };
  }

  it('creates global feedback without a session and requires Kimi login', async () => {
    const input = { kind: 'global', source: 'sidebar', category: 'bug', content: 'App issue' };
    signedIn = false;
    try {
      expect((await request('POST', '/feedback', input)).code).toBe(ErrorCode.AUTH_TOKEN_MISSING);
      expect(created).toEqual([]);
    } finally {
      signedIn = true;
    }

    const result = await request('POST', '/feedback', input);
    expect(result).toMatchObject({ code: 0, data: { feedback_id: 1 } });
    expect(created.at(-1)).toMatchObject({
      session_id: 'global',
      content: 'App issue',
      version: TEST_HOST_IDENTITY.version,
      info: { kind: 'global', source: 'sidebar', category: 'bug', client: 'desktop' },
    });
  });

  it('records the client and each upload choice without starting an upload', async () => {
    const previousUploads = uploads.size;
    const { code } = await request('POST', '/feedback', {
      kind: 'global', source: 'command', category: 'other', content: 'Feedback from a browser',
      session_id: 'example-session', upload_session: true, upload_logs: false,
    }, { 'x-kimi-client-ui-mode': 'web', 'x-kimi-client-version': '2.3.4', 'sec-ch-ua-platform': '"Windows"' });
    expect(code).toBe(0);
    expect(created.at(-1)).toMatchObject({ session_id: 'example-session', version: '2.3.4', os: 'Windows', info: { client: 'web', upload_session: true, upload_logs: false } });
    expect(uploads.size).toBe(previousUploads);
  });

  it('records menu as a global feedback source', async () => {
    const result = await request('POST', '/feedback', {
      kind: 'global', source: 'menu', category: 'suggestion', content: 'Feedback from Help menu',
    });
    expect(result.code).toBe(0);
    expect(created.at(-1)).toMatchObject({
      session_id: 'global',
      content: 'Feedback from Help menu',
      info: { kind: 'global', source: 'menu', category: 'suggestion', client: 'desktop' },
    });
  });

  it('attaches a chosen file and finalizes it using the same upload id', async () => {
    const { data } = await request<{ feedback_id: number }>('POST', '/feedback', {
      kind: 'global', source: 'command', category: 'suggestion', content: 'Improve contrast',
    });
    const form = new FormData();
    form.append('file', new Blob(['chosen image'], { type: 'image/png' }), 'image.png');
    const path = `/feedback/${data.feedback_id}/attachments?kind=media`;
    const result = await request<{ upload_id: number }>('POST', path, form);
    expect(result.code).toBe(0);
    expect(uploads.get(result.data.upload_id)).toEqual({
      feedback_id: data.feedback_id,
      file_name: 'image.png',
      file_size: Buffer.byteLength('chosen image'),
      file_hash: createHash('sha256').update('chosen image').digest('hex'),
    });
    expect(receivedParts.get(result.data.upload_id)).toEqual({ method: 'PUT', bytes: Buffer.from('chosen image') });
    expect(completed.at(-1)).toEqual({ upload_id: result.data.upload_id, parts: [{ part_number: 1, etag: '"test-etag"' }] });
    const invalid = new FormData();
    invalid.append('file', new Blob(['unexpected file type'], { type: 'text/plain' }), 'text.txt');
    expect((await request('POST', path, invalid)).code).toBe(ErrorCode.VALIDATION_FAILED);
    const oversized = new FormData();
    oversized.append('file', new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'image/png' }), 'image.png');
    expect((await request('POST', path, oversized)).code).toBe(ErrorCode.FILE_TOO_LARGE);
    expect((await request('POST', '/feedback/999/attachments?kind=media', form)).code).toBe(ErrorCode.FEEDBACK_REJECTED);
  });

  it('uses the signed POST method for a feedback attachment', async () => {
    const { data } = await request<{ feedback_id: number }>('POST', '/feedback', {
      kind: 'global', source: 'sidebar', category: 'other', content: 'Example attachment',
    });
    signedMethods.set(data.feedback_id, 'POST');
    const form = new FormData();
    form.append('file', new Blob(['chosen image'], { type: 'image/png' }), 'image.png');
    const result = await request<{ upload_id: number }>('POST', `/feedback/${data.feedback_id}/attachments?kind=media`, form);
    expect(result.code).toBe(0);
    expect(receivedParts.get(result.data.upload_id)).toEqual({ method: 'POST', bytes: Buffer.from('chosen image') });
    expect(completed.at(-1)).toEqual({ upload_id: result.data.upload_id, parts: [{ part_number: 1, etag: '"test-etag"' }] });
  });

  it('keeps a signed upload part active past one minute', async ({ onTestFinished }) => {
    const path = join(home, 'slow-attachment.zip');
    await writeFile(path, 'session');
    const file = await readFeedbackFile('session.zip', path);
    const feedback = new FeedbackGateway(new URL('https://example.test/coding/v1/feedback'), token);
    const storageUrl = 'https://example.test/storage/1';
    const caller = new AbortController();
    const partStarted = deferred<AbortSignal>();
    const stored = deferred();
    const requests = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected feedback request'))
      .mockResolvedValueOnce(Response.json({ upload: { id: 5, parts: [
        { part_number: 1, method: 'PUT', url: storageUrl, size: file.size },
      ] } }))
      .mockImplementationOnce(async (url, init) => {
        expect(url).toBe(storageUrl);
        expect(await new Response(init?.body).text()).toBe('session');
        const signal = init?.signal;
        assert.isOk(signal);
        partStarted.resolve(signal);
        await stored.promise;
        signal.throwIfAborted();
        return new Response(null, { headers: { etag: 'part-etag' } });
      })
      .mockResolvedValueOnce(Response.json({}));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => {
      requests.mockRestore();
      vi.useRealTimers();
    });
    const upload = feedback.upload(3, file, caller.signal);
    try {
      const signal = await partStarted.promise;
      vi.advanceTimersByTime(60_001);
      expect(signal.aborted).toBe(false);
      stored.resolve();
      await expect(upload).resolves.toBe(5);
    } finally {
      caller.abort();
      stored.resolve();
      await upload.catch(() => {});
    }
    expect(requests).toHaveBeenLastCalledWith('https://example.test/coding/v1/feedback/upload_complete', expect.objectContaining({
      body: JSON.stringify({ upload_id: 5, parts: [{ part_number: 1, etag: 'part-etag' }] }),
    }));
  });

  async function connectRemoteFeedbackHost({ onTestFinished }: TestContext) {
    const remoteFeedbackRequests: string[] = [];
    const remoteGateway = createServer((req, res) => {
      remoteFeedbackRequests.push(req.url ?? '');
      res.writeHead(409).end();
    });
    await new Promise<void>(resolve => remoteGateway.listen(0, '127.0.0.1', resolve));
    onTestFinished(() => remoteGateway[Symbol.asyncDispose]());
    const address = remoteGateway.address();
    if (address === null || typeof address === 'string') throw new Error('No remote feedback gateway port.');
    const remoteHome = await mkdtemp(join(home, 'remote-'));
    const remoteToken = 'test-remote-feedback-access-token';
    const oauth: IOAuthService = {
      ...server.core.accessor.get(IOAuthService),
      resolveTokenProvider: () => ({ getAccessToken: async () => remoteToken }),
      getCachedAccessToken: async () => remoteToken,
    };
    const remote = await startServer({
      hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: remoteHome,
      configPath: join(home, 'config.toml'), logLevel: 'silent', skipInstanceRegistry: true,
      env: { ...process.env, KIMI_CODE_FEEDBACK_BASE_URL: `http://127.0.0.1:${address.port}/coding/v1/` },
      seeds: [[IOAuthService, oauth]],
    });
    onTestFinished(() => remote.close());
    const remoteOrigin = `http://127.0.0.1:${remote.port}`;
    const forward = vi.fn<HostSession['request']>(async ({ method, path, headers, body, signal }) => {
      const forwardedHeaders = new Headers(authHeaders(remote));
      for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined) forwardedHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const response = await fetch(remoteOrigin + path, { method, headers: forwardedHeaders, body: body && new Uint8Array(body), signal });
      return { status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) };
    });
    const connect = vi.spyOn(server.hostBridges, 'connect').mockResolvedValue({
      request: forward,
      openWebSocket: () => { throw new Error('Unexpected WebSocket.'); },
    });
    onTestFinished(() => { connect.mockRestore(); });
    return { remote, remoteHome, connect, forward, remoteFeedbackRequests };
  }

  it('attaches a remote-only session to the global feedback created on this host', async context => {
    const { remote, remoteHome, connect, forward, remoteFeedbackRequests } = await connectRemoteFeedbackHost(context);
    const createdSession = await remote.app.inject({
      method: 'POST', url: '/api/v1/sessions', headers: authHeaders(remote), payload: { metadata: { cwd: remoteHome } },
    });
    const { data: session } = createdSession.json<{ data: { id: string; workspace_id: string } }>();
    const sessionDir = sessionDirOf(remoteHome, `sessions/${session.workspace_id}`, session.id);
    await writeFile(join(sessionDir, 'remote-only.txt'), 'This file belongs to the selected session.');
    const logs = join(remoteHome, 'logs');
    await mkdir(logs, { recursive: true });
    await writeFile(join(logs, 'kimi-code.log'), 'remote global log');
    await writeFile(join(logs, 'kimi-code-desktop.log'), 'remote desktop log');

    const { data: feedback } = await request<{ feedback_id: number }>('POST', '/feedback', {
      kind: 'global', source: 'sidebar', category: 'bug', content: 'Issue on a remote host', upload_session: true,
    });
    const path = `/feedback/${feedback.feedback_id}/attachments/session`;
    const attached = await request<{ upload_id: number }>('POST', path, { session_id: session.id, host_id: 'example' });
    expect(attached.code, JSON.stringify(attached)).toBe(0);
    expect(connect).toHaveBeenCalledWith('example');
    const [prepare, download, remove] = forward.mock.calls.map(([req]) => req);
    expect(prepare).toMatchObject({ method: 'POST', path: '/api/v1/feedback/session-archives' });
    assert.isDefined(prepare?.body);
    expect(JSON.parse(prepare.body.toString())).toEqual({ session_id: session.id });
    assert.isDefined(download);
    expect(download).toMatchObject({
      method: 'GET', path: expect.stringMatching(/^\/api\/v1\/files\/[^/]+$/),
      headers: { range: expect.stringMatching(/^bytes=0-\d+$/) },
    });
    expect(remove).toMatchObject({ method: 'DELETE', path: download.path });
    expect(forward).toHaveBeenCalledTimes(3);
    const deleted = await remote.app.inject({ method: 'GET', url: download.path, headers: authHeaders(remote) });
    expect(deleted.json()).toMatchObject({ code: ErrorCode.FILE_NOT_FOUND });
    expect(uploads.get(attached.data.upload_id)).toMatchObject({ feedback_id: feedback.feedback_id, file_name: 'session.zip' });
    const archive = receivedParts.get(attached.data.upload_id)?.bytes;
    expect(archive?.includes(Buffer.from('remote-only.txt'))).toBe(true);
    for (const forbidden of ['logs/global/kimi-code.log', 'logs/kimi-desktop.log', 'logs/kimi-web.jsonl']) {
      expect(archive?.includes(Buffer.from(forbidden))).toBe(false);
    }
    expect(completed.at(-1)).toMatchObject({ upload_id: attached.data.upload_id });

    const previousUploads = uploads.size;
    const missing = await request('POST', path, { session_id: 'missing-session', host_id: 'example' });
    expect(missing.code).toBe(ErrorCode.SESSION_NOT_FOUND);
    expect(forward).toHaveBeenCalledTimes(4);
    expect(uploads.size).toBe(previousUploads);
    expect(remoteFeedbackRequests).toEqual([]);
  });

  it('cancels the remote archive export when the feedback client disconnects', async context => {
    const { remote, remoteFeedbackRequests } = await connectRemoteFeedbackHost(context);
    const started = new Promise<AbortSignal>(resolve => {
      vi.spyOn(remote.core.accessor.get(ISessionExportService), 'export').mockImplementationOnce(async (_input, options) => {
        const signal = options?.signal;
        assert.isDefined(signal);
        resolve(signal);
        await once(signal, 'abort');
        throw new Error('Session export cancelled.');
      });
    });
    const { data } = await request<{ feedback_id: number }>('POST', '/feedback', {
      kind: 'global', source: 'sidebar', category: 'other', content: 'Cancel the attachment', upload_session: true,
    });
    const previousUploads = uploads.size;
    const client = new AbortController();
    context.onTestFinished(() => client.abort());
    const response = fetch(`http://127.0.0.1:${server.port}/api/v1/feedback/${data.feedback_id}/attachments/session`, {
      method: 'POST', headers: authHeaders(server, { 'content-type': 'application/json' }), signal: client.signal,
      body: JSON.stringify({ host_id: 'example', session_id: 'example-session' }),
    });
    const remoteSignal = await Promise.race([
      started,
      response.then(async result => { throw new Error(await result.text()); }),
    ]);
    const stopped = once(remoteSignal, 'abort');
    client.abort();
    await expect(response).rejects.toMatchObject({ name: 'AbortError' });
    await stopped;
    expect(uploads.size).toBe(previousUploads);
    expect(remoteFeedbackRequests).toEqual([]);
  });

  it('rates the selected historical turn, updates that rating, and uploads a session without diagnostics', async () => {
    const { data: session } = await request<{ id: string }>('POST', '/sessions', { metadata: { cwd: home } });
    async function replyTo(text: string, count: number, model: 'stub' | 'alternate'): Promise<{ turnId: string; replyId: string }> {
      const prompt = await request('POST', `/sessions/${session.id}/prompts`, {
        content: [{ type: 'text', text }], model, permission_mode: 'yolo',
      });
      expect(prompt.code).toBe(0);
      return vi.waitFor(async () => {
        const { data } = await request<{ turns: { turn_id: string; status: string; items: { item_id: string; type: string }[] }[] }>(
          'GET', `/sessions/${session.id}/agents/${MAIN_AGENT_ID}/turns`,
        );
        const replies = data.turns.filter((turn) =>
          turn.status === 'ended' && turn.items.some((item) => item.type === 'assistant_message'),
        );
        expect(replies).toHaveLength(count);
        const last = replies.at(-1);
        const reply = last?.items.findLast((item) => item.type === 'assistant_message');
        if (last === undefined || reply === undefined) throw new Error('No reply to rate.');
        return { turnId: last.turn_id, replyId: reply.item_id };
      }, { timeout: 5_000 });
    }

    model.script(withRequestId('request-1', say('First reply.')));
    managed.script(withRequestId('request-2', say('Second reply.')));
    const historical = await replyTo('first prompt', 1, 'stub');
    const newer = await replyTo('second prompt', 2, 'alternate');
    const newerRating = await request('POST', '/feedback', {
      kind: 'turn', session_id: session.id, turn_id: newer.turnId, reply_id: newer.replyId, rating: 'up',
    });
    expect(newerRating.code).toBe(0);
    expect(created.at(-1)).toMatchObject({
      content: 'null',
      model: 'different-model',
      info: { request_id: 'request-2', is_kfc: true },
    });
    await closeSessionById(server.core.accessor, session.id);
    const target = { kind: 'turn', session_id: session.id, turn_id: historical.turnId, reply_id: historical.replyId, rating: 'down' };
    expect((await request('POST', '/feedback', { ...target, turn_id: 'missing' })).code).toBe(ErrorCode.TURN_NOT_FOUND);
    expect((await request('POST', '/feedback', { ...target, reply_id: 'missing' })).code).toBe(ErrorCode.TURN_NOT_FOUND);
    const result = await request<{ feedback_id: number }>('POST', '/feedback', target);
    expect(result.code).toBe(0);
    expect(created.at(-1)).toMatchObject({
      session_id: session.id,
      content: 'null',
      model: 'stub',
      info: { kind: 'turn', source: 'rating', rating: 'down', turn_id: historical.turnId, reply_id: historical.replyId, request_id: 'request-1', model_id: 'stub', provider: 'openai', is_kfc: false },
    });
    const path = `/feedback/${result.data.feedback_id}`;
    expect((await request('PATCH', path, { kind: 'details', reasons: ['incorrect'], content: 'Wrong answer', upload_session: true })).code).toBe(0);
    expect(updates.at(-1)).toEqual({
      feedback_id: result.data.feedback_id, content: 'Wrong answer', info: { reasons: ['incorrect'], upload_session: true },
    });

    const logs = join(home, 'logs');
    await mkdir(logs, { recursive: true });
    await writeFile(join(logs, 'kimi-code.log'), 'global log that was not selected');
    await writeFile(join(logs, 'kimi-code-desktop.log'), 'desktop log that was not selected');

    const previousParts = receivedParts.size;
    const rejected = await request('POST', '/feedback/999/attachments/session', { session_id: session.id });
    expect(rejected.code).toBe(ErrorCode.FEEDBACK_REJECTED);
    expect(receivedParts.size).toBe(previousParts);
    const attached = await request<{ upload_id: number }>('POST', `${path}/attachments/session`, { session_id: session.id });
    expect(attached.code, JSON.stringify(attached)).toBe(0);
    expect(uploads.get(attached.data.upload_id)).toMatchObject({ feedback_id: result.data.feedback_id, file_name: 'session.zip' });
    const archive = receivedParts.get(attached.data.upload_id)?.bytes;
    expect(archive?.includes(Buffer.from('manifest.json'))).toBe(true);
    for (const forbidden of ['logs/global/kimi-code.log', 'logs/kimi-desktop.log', 'logs/kimi-web.jsonl']) {
      expect(archive?.includes(Buffer.from(forbidden))).toBe(false);
    }
    expect((await request('PATCH', path, { kind: 'cancel' })).code).toBe(0);
    expect(updates.at(-1)).toEqual({ feedback_id: result.data.feedback_id, info: { cancel: true } });
  });

  async function completedTurn(sessionId: string, text: string) {
    return vi.waitFor(async () => {
      const { data } = await request<{ turns: { turn_id: string; status: string; items: { item_id: string; type: string; text?: string }[] }[] }>(
        'GET', `/sessions/${sessionId}/agents/${MAIN_AGENT_ID}/turns`,
      );
      const row = data.turns.find(turn => turn.status === 'ended' && turn.items.some(item => item.text === text));
      if (row === undefined) throw new Error(`Waiting for reply "${text}": ${JSON.stringify(data.turns)}`);
      return row;
    }, { timeout: 5_000 });
  }

  function delegate(background = false): ReplyStep {
    return agent(
      { description: 'Review example', prompt: 'Review the example.', run_in_background: background },
      { id: 'delegate', text: 'I will consult a helper.' },
    );
  }

  async function rateDelegatedReplies(prefix: 'recorded' | 'legacy') {
    const { data: session } = await request<{ id: string; workspace_id: string }>('POST', '/sessions', { metadata: { cwd: home } });
    model.script(
      withRequestId(`${prefix}-delegate`, delegate()),
      withRequestId(`${prefix}-final`, say('The review is complete.')),
    );
    managed.script(withRequestId(`${prefix}-helper`, say('The helper reviewed the example.')));
    const prompt = await request('POST', `/sessions/${session.id}/prompts`, {
      content: [{ type: 'text', text: 'Review with a helper.' }], model: 'stub', permission_mode: 'yolo',
    });
    expect(prompt.code).toBe(0);
    const turn = await completedTurn(session.id, 'The review is complete.');
    await closeSessionById(server.core.accessor, session.id);
    if (prefix === 'legacy') {
      const dir = sessionDirOf(home, `sessions/${session.workspace_id}`, session.id);
      const wire = join(dir, 'agents', MAIN_AGENT_ID, 'wire.jsonl');
      const lines = (await readFile(wire, 'utf8')).split('\n').map(line => {
        if (line === '') return line;
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record['type'] !== 'turn.ended') return line;
        delete record['modelSteps'];
        delete record['replyModel'];
        return JSON.stringify(record);
      });
      await writeFile(wire, lines.join('\n'));
    }
    const rate = async (text: string) => {
      const replyId = turn.items.find(item => item.text === text)?.item_id;
      expect(replyId).toBeDefined();
      const rating = await request('POST', '/feedback', { kind: 'turn', session_id: session.id, turn_id: turn.turn_id, reply_id: replyId, rating: 'up' });
      expect(rating.code).toBe(0);
      return created.at(-1);
    };
    const final = await rate('The review is complete.');
    const earlier = await rate('I will consult a helper.');
    return { final, earlier };
  }

  it('recovers only recorded identifiers when reopening a session without model steps', async () => {
    const { final, earlier } = await rateDelegatedReplies('legacy');
    expect(final).toMatchObject({ model: null, info: { request_id: 'legacy-final' } });
    expect(final).not.toHaveProperty('info.is_kfc');
    expect(final).not.toHaveProperty('info.participating_models');
    expect(earlier).toHaveProperty('model', null);
    expect(earlier).not.toHaveProperty('info.request_id');
  });

  it('attributes the selected reply to the recorded step and its dispatched models after reopening', async () => {
    const { final, earlier } = await rateDelegatedReplies('recorded');
    const main = { role: 'step', provider: 'openai', model_id: 'stub', is_kfc: false };
    const child = { role: 'subagent', provider: 'openai', model_id: 'different-model', is_kfc: true };
    expect(final).toMatchObject({
      info: {
        model_id: 'stub', is_kfc: false, request_id: 'recorded-final',
        participating_models: [{ ...main, step: 1 }, { ...child, step: 1 }, { ...main, step: 2 }],
      },
    });
    expect(earlier).toMatchObject({
      info: { request_id: 'recorded-delegate', participating_models: [{ ...main, step: 1 }, { ...child, step: 1 }] },
    });
  });

  it('records a dispatched background model before it returns and keeps it out of a later reply', async () => {
    const { data: session } = await request<{ id: string }>('POST', '/sessions', { metadata: { cwd: home } });
    model.script(
      withRequestId('background-delegate', delegate(true)),
      withRequestId('background-running', say('The helper is running.')),
      withRequestId('separate-reply', say('A separate reply.')),
      withRequestId('background-notification', say('The helper has finished.')),
    );
    managed.script(held('background-result', withRequestId('background-helper', say('A later helper result.'))));
    const result = model.hold('background-result');
    try {
      const base = `/sessions/${session.id}`;
      await request('POST', `${base}/prompts`, { content: [{ type: 'text', text: 'Start a background helper.' }], permission_mode: 'yolo' });
      const first = await completedTurn(session.id, 'The helper is running.');
      await result.reached();
      const rate = async (turnId: string) => {
        const rating = await request('POST', '/feedback', { kind: 'turn', session_id: session.id, turn_id: turnId, rating: 'up' });
        expect(rating.code).toBe(0);
        return created.at(-1);
      };
      const main = { role: 'step', model_id: 'stub', is_kfc: false };
      expect(await rate(first.turn_id)).toMatchObject({ info: {
        request_id: 'background-running',
        participating_models: [{ ...main, step: 1 }, { role: 'subagent', model_id: 'different-model', is_kfc: true }, { ...main, step: 2 }],
      } });
      await request('POST', `${base}/prompts`, { content: [{ type: 'text', text: 'A separate question.' }], permission_mode: 'yolo' });
      const next = await completedTurn(session.id, 'A separate reply.');
      expect(await rate(next.turn_id)).toMatchObject({ info: { request_id: 'separate-reply', participating_models: [{ ...main, step: 1 }] } });
    } finally {
      result.release();
    }
    await completedTurn(session.id, 'The helper has finished.');
  });
});
