import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import {
  closeSessionById,
  FeedbackModelRequestRecorded,
  getLiveSessionById,
  IEventBus,
  IEventDispatcher,
  IOAuthService,
  ISessionContext,
  ISessionExportService,
  MAIN_AGENT_ID,
} from '@moonshot-ai/agent-core-v2';
import { ContextAppendMessage } from '@moonshot-ai/agent-core-v2/agent/contextMemory/contextEvents';
import { TurnStarted } from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import { TurnEnded, TurnPrompt } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { ensureMainAgent } from '../src/transport/mainAgent';
import { ManagedFeedbackGateway } from '../src/services/feedback';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

describe('feedback routes', () => {
  let server: RunningServer;
  let kfc: Server;
  let storage: Server;
  let home: string;
  let baseUrl: string;
  let storageUrl: string;
  let kfcRequests: RecordedRequest[];
  let storageRequests: RecordedRequest[];
  let updateStatus: number;
  let updateMessage: string;
  let createStatus: number;
  let partStatus: number;
  let getAccessToken: ReturnType<typeof vi.fn<(options?: { readonly force?: boolean }) => Promise<string>>>;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-feedback-'));
    kfcRequests = [];
    storageRequests = [];
    updateStatus = 200;
    updateMessage = 'update window expired';
    createStatus = 200;
    partStatus = 200;
    storage = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        storageRequests.push({
          method: req.method ?? '',
          url: req.url ?? '',
          authorization: req.headers.authorization,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(partStatus, partStatus === 200 ? { etag: '"etag-1"' } : undefined);
        res.end(partStatus === 200 ? '' : 'storage failed');
      });
    });
    await new Promise<void>((resolve) => storage.listen(0, '127.0.0.1', resolve));
    storageUrl = `http://127.0.0.1:${(storage.address() as AddressInfo).port}`;
    kfc = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        kfcRequests.push({
          method: req.method ?? '',
          url: req.url ?? '',
          authorization: req.headers.authorization,
          body: raw.length > 0 ? JSON.parse(raw) : undefined,
        });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/feedback') {
          res.writeHead(createStatus);
          res.end(JSON.stringify(createStatus === 200 ? { feedback_id: 42 } : { error: { message: 'kfc unauthorized' } }));
          return;
        }
        if (req.url === '/feedback/update') {
          res.writeHead(updateStatus);
          res.end(JSON.stringify(updateStatus === 200 ? {} : { error: { message: updateMessage } }));
          return;
        }
        if (req.url === '/feedback/upload_url') {
          res.writeHead(200);
          res.end(JSON.stringify({
            upload: {
              id: 28,
              upload_id: 'object-storage-upload-id',
              parts: [{ part_number: 1, url: `${storageUrl}/part-1`, method: 'PUT', size: 5 }],
            },
          }));
          return;
        }
        res.writeHead(200);
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => kfc.listen(0, '127.0.0.1', resolve));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      env: { ...process.env, KIMI_CODE_BASE_URL: `http://127.0.0.1:${(kfc.address() as AddressInfo).port}` },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
    getAccessToken = vi.fn(async () => 'managed-kimi-token');
    vi.spyOn(server.core.accessor.get(IOAuthService), 'resolveTokenProvider').mockReturnValue({
      getAccessToken,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    await new Promise<void>((resolve) => {
      kfc.close(() => {
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      storage.close(() => {
        resolve();
      });
    });
    await rm(home, { recursive: true, force: true });
  });

  async function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: authHeaders(server, { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    });
  }

  it('creates reply and sessionless global feedback through managed OAuth', async () => {
    const reply = await post('/api/v1/feedback', {
      session_id: 'session-1',
      content: '',
      version: '1.2.3',
      os: 'macOS 26.1',
      info: {
        schema_version: 1,
        kind: 'reply',
        source: 'reply_button',
        client: 'desktop',
        rating: 'positive',
        turn_id: 'turn-1',
        reasons: [],
        upload_session: false,
        upload_logs: false,
        attachments: [],
        cancel: false,
      },
    });
    expect(reply.status).toBe(200);
    const replyBody = (await reply.json()) as { readonly data: unknown };
    expect(replyBody).toMatchObject({ code: 0, data: { feedback_id: 42 } });
    expect(replyBody.data).toEqual({ feedback_id: 42 });
    expect(JSON.stringify(replyBody)).not.toContain('managed-kimi-token');

    const global = await post('/api/v1/feedback', {
      content: 'global details',
      version: '1.2.3',
      os: 'macOS 26.1',
      info: {
        schema_version: 1,
        kind: 'global',
        source: 'sidebar',
        client: 'desktop',
        category: 'bug',
        upload_session: false,
        upload_logs: false,
        attachments: [],
      },
    });
    expect(global.status).toBe(200);
    expect(kfcRequests.map((request) => request.authorization)).toEqual([
      'Bearer managed-kimi-token',
      'Bearer managed-kimi-token',
    ]);
    expect(kfcRequests[0]?.body).toMatchObject({ session_id: 'session-1', model: null });
    expect(kfcRequests[1]?.body).toEqual({
      content: 'global details',
      version: '1.2.3',
      os: 'macOS 26.1',
      model: null,
      info: {
        schema_version: 1,
        kind: 'global',
        source: 'sidebar',
        client: 'desktop',
        category: 'bug',
        upload_session: false,
        upload_logs: false,
        attachments: [],
      },
    });
    expect(JSON.stringify(kfcRequests[1]?.body)).not.toContain('session_id');
  });

  it('uses the active global region without a base URL override', async () => {
    await server.close();
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      env: { ...process.env, KIMI_CODE_BASE_URL: undefined },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
    vi.spyOn(server.core.accessor.get(IOAuthService), 'getRegion').mockReturnValue('global');
    vi.spyOn(server.core.accessor.get(IOAuthService), 'resolveTokenProvider').mockReturnValue({
      getAccessToken: vi.fn(async () => 'managed-kimi-token'),
    });
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/coding/v1/feedback')) {
        requested.push(url);
        return originalFetch(`http://127.0.0.1:${(kfc.address() as AddressInfo).port}/feedback`, init);
      }
      return originalFetch(input, init);
    });
    const response = await post('/api/v1/feedback', {
      content: 'global details',
      version: '1.2.3',
      os: 'macOS 26.1',
      info: {
        schema_version: 1,
        kind: 'global',
        source: 'sidebar',
        client: 'desktop',
        category: 'bug',
        upload_session: false,
        upload_logs: false,
        attachments: [],
      },
    });
    expect(response.status).toBe(200);
    expect(requested).toEqual(['https://api.kimi.ai/coding/v1/feedback']);
  });

  it('maps a persisted root turn to the final model request after the session closes', async () => {
    const createdResponse = await post('/api/v1/sessions', { metadata: { cwd: home } });
    const created = (await createdResponse.json()) as { readonly data: { readonly id: string } };
    const sessionId = created.data.id;
    const session = getLiveSessionById(server.core.accessor, sessionId);
    if (session === undefined) throw new Error('expected a live session');
    const agent = await ensureMainAgent(session);
    const dispatcher = agent.accessor.get(IEventDispatcher);
    const origin = { kind: 'user' } as const;
    await dispatcher.dispatch(new TurnPrompt({ agentId: MAIN_AGENT_ID, input: [], origin, turnId: 7 }));
    await dispatcher.dispatch(new ContextAppendMessage({
      agentId: MAIN_AGENT_ID,
      message: { role: 'user', content: [{ type: 'text', text: 'Please answer.' }], origin },
    }));
    agent.accessor.get(IEventBus).publish(new TurnStarted({ agentId: MAIN_AGENT_ID, turnId: 7, origin }));
    await dispatcher.dispatch(new FeedbackModelRequestRecorded({
      agentId: MAIN_AGENT_ID,
      rootTurnId: 7,
      turnId: 7,
      step: 1,
      model: 'model-old',
      provider: 'kimi',
      traceId: 'trace-old',
    }));
    await dispatcher.dispatch(new FeedbackModelRequestRecorded({
      agentId: MAIN_AGENT_ID,
      rootTurnId: 7,
      turnId: 7,
      step: 2,
      model: 'model-final',
      provider: 'openai',
      traceId: 'trace-final',
    }));
    await dispatcher.dispatch(new TurnEnded({
      agentId: MAIN_AGENT_ID,
      turnId: 7,
      reason: 'completed',
      requestId: 'conversation-trace',
    }));
    await dispatcher.flush();
    await closeSessionById(server.core.accessor, sessionId);

    const turnsResponse = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/agents/main/turns`, {
      headers: authHeaders(server),
    });
    const turns = (await turnsResponse.json()) as {
      readonly data: { readonly turns: readonly { readonly turn_id: string }[] };
    };
    const turnId = turns.data.turns.at(-1)?.turn_id;
    if (turnId === undefined) throw new Error('expected a conversation turn');

    const response = await post('/api/v1/feedback', {
      session_id: sessionId,
      content: '',
      version: '1.2.3',
      os: 'macOS 26.1',
      info: {
        schema_version: 1,
        kind: 'reply',
        source: 'reply_button',
        client: 'desktop',
        rating: 'positive',
        turn_id: turnId,
        reasons: [],
        upload_session: false,
        upload_logs: false,
        attachments: [],
        cancel: false,
      },
    });

    expect(response.status).toBe(200);
    expect(kfcRequests[0]?.body).toMatchObject({
      session_id: sessionId,
      model: 'model-final',
      info: {
        turn_id: turnId,
        trace_id: 'trace-final',
        provider: 'openai',
        participant_models: [
          { model: 'model-old', provider: 'kimi' },
          { model: 'model-final', provider: 'openai' },
        ],
      },
    });
  });

  it('rejects a session upload grant without a session target', async () => {
    const response = await post('/api/v1/feedback', {
      content: 'global details',
      version: '1.2.3',
      os: 'macOS 26.1',
      info: {
        schema_version: 1,
        kind: 'global',
        source: 'sidebar',
        client: 'desktop',
        category: 'bug',
        upload_session: true,
        upload_logs: false,
        attachments: [],
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      code: 40001,
      msg: 'session upload requires session_id',
    });
    expect(kfcRequests).toEqual([]);
  });

  it('preserves update conflicts and maps KFC auth failures to upstream errors', async () => {
    updateStatus = 409;
    const conflict = await post('/api/v1/feedback/update', {
      feedback_id: 42,
      info: { cancel: true },
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ msg: 'update window expired' });

    updateStatus = 400;
    updateMessage = 'invalid feedback patch';
    const invalid = await post('/api/v1/feedback/update', {
      feedback_id: 42,
      content: 'invalid',
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ msg: 'invalid feedback patch' });

    createStatus = 401;
    const unauthorized = await post('/api/v1/feedback', {
      content: 'global',
      version: '1.2.3',
      os: 'macOS 26.1',
      info: {
        schema_version: 1,
        kind: 'global',
        source: 'sidebar',
        client: 'desktop',
        category: 'other',
        upload_session: false,
        upload_logs: false,
        attachments: [],
      },
    });
    expect(unauthorized.status).toBe(502);
    expect(await unauthorized.json()).toMatchObject({ msg: 'kfc unauthorized' });
  });

  it('downloads a feedback session package with allowlisted ZIP entries and a real size', async () => {
    const createdResponse = await post('/api/v1/sessions', { metadata: { cwd: home } });
    const created = (await createdResponse.json()) as { readonly data: { readonly id: string } };
    const sessionId = created.data.id;
    const session = getLiveSessionById(server.core.accessor, sessionId);
    if (session === undefined) throw new Error('expected a live session');
    const sessionDir = session.accessor.get(ISessionContext).sessionDir;
    await mkdir(join(sessionDir, 'agents', 'main', 'file-history'), { recursive: true });
    await mkdir(join(sessionDir, 'agents', 'sub-1'), { recursive: true });
    await mkdir(join(sessionDir, 'logs', 'global'), { recursive: true });
    await mkdir(join(sessionDir, 'diagnostics'), { recursive: true });
    await writeFile(
      join(sessionDir, 'agents', 'main', 'wire.jsonl'),
      [
        JSON.stringify({ type: 'metadata', time: 1_700_000_000_000 }),
        JSON.stringify({ type: 'context.append_message', role: 'user', text: 'hello' }),
        JSON.stringify({ type: 'tool.call', name: 'Edit', path: 'src/demo.ts' }),
        JSON.stringify({ type: 'file_history.tracked', path: 'src/demo.ts' }),
      ].join('\n'),
    );
    await writeFile(join(sessionDir, 'agents', 'main', 'file-history', 'hash@v1'), 'before edit\n');
    await writeFile(
      join(sessionDir, 'agents', 'sub-1', 'wire.jsonl'),
      `${JSON.stringify({ type: 'context.append_message', role: 'assistant', text: 'done' })}\n`,
    );
    await writeFile(join(sessionDir, 'logs', 'kimi-code.log'), 'session log\n');
    await writeFile(join(sessionDir, 'logs', 'global', 'kimi-code.log'), 'global log\n');
    await writeFile(join(sessionDir, 'logs', 'kimi-desktop.log'), 'desktop log\n');
    await writeFile(join(sessionDir, 'logs', 'kimi-web.jsonl'), 'web log\n');
    await writeFile(join(sessionDir, 'diagnostics', 'snapshot.json'), '{}\n');
    await writeFile(join(sessionDir, 'crash.dump'), 'crash\n');

    const response = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/feedback_package`, {
      method: 'POST',
      headers: authHeaders(server),
    });
    const archive = Buffer.from(await response.arrayBuffer());
    const entries = readZipEntries(archive);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="session.zip"');
    expect(response.headers.get('content-length')).toBe(String(archive.length));
    expect([...entries.keys()].toSorted()).toEqual([
      'agents/main/file-history/hash@v1',
      'agents/main/wire.jsonl',
      'agents/sub-1/wire.jsonl',
      'manifest.json',
      'state.json',
    ]);
    expect(entries.get('agents/main/file-history/hash@v1')?.toString('utf8')).toBe('before edit\n');
  });

  it('streams attachments without exposing either token and tries each part once', async () => {
    const upload = async (): Promise<Response> => fetch(`${baseUrl}/api/v1/feedback/42/attachments`, {
      method: 'POST',
      headers: authHeaders(server, {
        'content-type': 'application/octet-stream',
        'x-feedback-file-name': encodeURIComponent('session.zip'),
        'x-feedback-file-size': '5',
      }),
      body: 'hello',
    });

    getAccessToken.mockResolvedValueOnce('grant-token').mockResolvedValueOnce('complete-token');
    const uploaded = await upload();
    expect(uploaded.status).toBe(200);
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(kfcRequests.find((request) => request.url === '/feedback/upload_url')?.authorization).toBe('Bearer grant-token');
    expect(kfcRequests.at(-1)?.authorization).toBe('Bearer complete-token');
    expect(storageRequests).toHaveLength(1);
    expect(storageRequests[0]).toMatchObject({ method: 'PUT', body: 'hello', authorization: undefined });
    expect(kfcRequests.at(-1)?.body).toEqual({
      upload_id: 28,
      parts: [{ part_number: 1, etag: '"etag-1"' }],
    });
    expect(JSON.stringify(kfcRequests.at(-2)?.body)).not.toContain('object-storage-upload-id');

    partStatus = 500;
    const failed = await upload();
    expect(failed.status).toBe(502);
    expect(storageRequests).toHaveLength(2);
    expect(kfcRequests.filter((request) => request.url === '/feedback/upload_complete')).toHaveLength(1);
    expect(JSON.stringify(await failed.json())).not.toContain('managed-kimi-token');

    const requestCount = kfcRequests.length;
    const mismatch = await fetch(`${baseUrl}/api/v1/feedback/42/attachments`, {
      method: 'POST',
      headers: authHeaders(server, {
        'content-type': 'application/octet-stream',
        'x-feedback-file-name': encodeURIComponent('session.zip'),
        'x-feedback-file-size': '4',
      }),
      body: 'hello',
    });
    expect(mismatch.status).toBe(400);
    expect(kfcRequests).toHaveLength(requestCount);
    expect(storageRequests).toHaveLength(2);
  });
  it('cancels an upstream attachment upload without completing it', async () => {
    let uploadSignal: AbortSignal | undefined;
    const upload = ManagedFeedbackGateway.prototype.upload;
    vi.spyOn(ManagedFeedbackGateway.prototype, 'upload').mockImplementation(async function (this: ManagedFeedbackGateway, feedbackId, input, options) {
      uploadSignal = options?.signal;
      return upload.call(this, feedbackId, input, options);
    });
    let partStarted!: () => void;
    let releasePart!: () => void;
    const started = new Promise<void>((resolve) => { partStarted = resolve; });
    const released = new Promise<void>((resolve) => { releasePart = resolve; });
    let storageAborted = false;
    storage.removeAllListeners('request');
    storage.on('request', (req, res) => {
      req.on('aborted', () => { storageAborted = true; });
      res.on('close', () => {
        if (!res.writableFinished) storageAborted = true;
      });
      req.resume();
      req.on('end', () => {
        partStarted();
        void released.then(() => {
          res.writeHead(200, { etag: '"etag-1"' });
          res.end();
        });
      });
    });
    const cancellation = new AbortController();
    const request = fetch(`${baseUrl}/api/v1/feedback/42/attachments`, {
      method: 'POST',
      headers: authHeaders(server, {
        'content-type': 'application/octet-stream',
        'x-feedback-file-name': encodeURIComponent('session.zip'),
        'x-feedback-file-size': '5',
      }),
      body: 'hello',
      signal: cancellation.signal,
    });
    try {
      await started;
      cancellation.abort();
      await expect(request).rejects.toThrow();
      await vi.waitFor(() => expect(uploadSignal?.aborted).toBe(true));
    } finally {
      releasePart();
    }

    await vi.waitFor(() => {
      expect(storageAborted || kfcRequests.some((request) => request.url === '/feedback/upload_complete')).toBe(true);
    });
    expect(kfcRequests.filter((request) => request.url === '/feedback/upload_complete')).toEqual([]);
  });

  it('stops waiting for an upload token after cancellation', async () => {
    let uploadSignal: AbortSignal | undefined;
    let finished: ReturnType<ManagedFeedbackGateway['upload']> | undefined;
    const upload = ManagedFeedbackGateway.prototype.upload;
    vi.spyOn(ManagedFeedbackGateway.prototype, 'upload').mockImplementation(async function (this: ManagedFeedbackGateway, feedbackId, input, options) {
      uploadSignal = options?.signal;
      finished = upload.call(this, feedbackId, input, options);
      return finished;
    });
    let tokenStarted!: () => void;
    let resolveToken!: (token: string) => void;
    const started = new Promise<void>((resolve) => { tokenStarted = resolve; });
    const token = new Promise<string>((resolve) => { resolveToken = resolve; });
    getAccessToken.mockImplementation(async () => {
      tokenStarted();
      return token;
    });
    const cancellation = new AbortController();
    const request = fetch(`${baseUrl}/api/v1/feedback/42/attachments`, {
      method: 'POST',
      headers: authHeaders(server, {
        'content-type': 'application/octet-stream',
        'x-feedback-file-name': encodeURIComponent('session.zip'),
        'x-feedback-file-size': '5',
      }),
      body: 'hello',
      signal: cancellation.signal,
    });

    try {
      await started;
      cancellation.abort();
      await expect(request).rejects.toThrow();
      await vi.waitFor(() => expect(uploadSignal?.aborted).toBe(true));
      if (finished === undefined) throw new Error('expected an upload');
      const outcome = await Promise.race([
        finished.then(() => 'completed', (error: unknown) => error),
        new Promise<'timeout'>((resolve) => setTimeout(() => { resolve('timeout'); }, 50)),
      ]);
      expect(outcome).toMatchObject({ name: 'AbortError' });
      expect(kfcRequests).toEqual([]);
    } finally {
      resolveToken('managed-kimi-token');
      await finished?.catch(() => {});
    }
  });

  it('cancels feedback export and removes its temporary directory', async () => {
    const createdResponse = await post('/api/v1/sessions', { metadata: { cwd: home } });
    const created = (await createdResponse.json()) as { readonly data: { readonly id: string } };
    const sessionId = created.data.id;
    const service = server.core.accessor.get(ISessionExportService);
    const exportFeedback = service.exportFeedback.bind(service);
    let exportStarted!: () => void;
    const started = new Promise<void>((resolve) => { exportStarted = resolve; });
    let outputPath = '';
    let exportSignal: AbortSignal | undefined;
    let finished: ReturnType<typeof exportFeedback> | undefined;
    vi.spyOn(service, 'exportFeedback').mockImplementation((input, options) => {
      outputPath = input.outputPath ?? '';
      exportSignal = options?.signal;
      exportStarted();
      finished = exportFeedback(input, options);
      return finished;
    });
    const cancellation = new AbortController();
    const download = fetch(`${baseUrl}/api/v1/sessions/${sessionId}/feedback_package`, {
      method: 'POST',
      headers: authHeaders(server),
      signal: cancellation.signal,
    });
    await started;
    cancellation.abort();
    await expect(download).rejects.toThrow();
    await finished?.catch(() => {});

    expect(exportSignal?.aborted).toBe(true);
    expect(outputPath).not.toBe('');
    await vi.waitFor(async () => {
      await expect(stat(dirname(outputPath))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});

function readZipEntries(archive: Buffer): Map<string, Buffer> {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const endOffset = archive.lastIndexOf(endSignature);
  if (endOffset < 0) throw new Error('ZIP end record not found');
  const entryCount = archive.readUInt16LE(endOffset + 10);
  let centralOffset = archive.readUInt32LE(endOffset + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(centralOffset) !== 0x02014b50) {
      throw new Error('Invalid ZIP central directory entry');
    }
    const method = archive.readUInt16LE(centralOffset + 10);
    const compressedSize = archive.readUInt32LE(centralOffset + 20);
    const nameLength = archive.readUInt16LE(centralOffset + 28);
    const extraLength = archive.readUInt16LE(centralOffset + 30);
    const commentLength = archive.readUInt16LE(centralOffset + 32);
    const localOffset = archive.readUInt32LE(centralOffset + 42);
    const name = archive.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString('utf8');
    if (archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('Invalid ZIP local entry');
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    if (method === 0) entries.set(name, Buffer.from(compressed));
    else if (method === 8) entries.set(name, inflateRawSync(compressed));
    else throw new Error(`Unsupported ZIP compression method: ${method}`);
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
