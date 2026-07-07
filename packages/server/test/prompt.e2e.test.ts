/**
 * Prompts end-to-end tests (W7.2 / Chain 4 / P1.4).
 *
 * **Bootstrap strategy**: spawn the real server (port 0, tmp lock + bridge
 * home) and exercise:
 *   1. POST /api/v1/sessions/{sid}/prompts validation (40001 on bad body, 40401
 *      on bad sid).
 *   2. Lifecycle event synthesis: register a fake active prompt directly on
 *      the IPromptService (so we don't have to drive agent-core through the
 *      bridge.rpc.prompt path, which requires provider creds). Publish
 *      `turn.started` → `assistant.delta` × N → `turn.ended` directly through
 *      the event bus. Verify a WS subscriber receives them all PLUS the
 *      synthesized `prompt.completed`.
 *
 * We don't drive a REAL prompt through agent-core in this test because:
 *   - prompt execution requires provider credentials + network IO.
 *   - the architecture under test is the server's event-service synthesis +
 *     fan-out path, not the model's behavior.
 *   - the services-layer unit tests at
 *     `packages/services/test/prompt-service.test.ts` exercise the protocol
 *     → kosong content adapter against a mocked bridge.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Jimp } from 'jimp';

import type { Event, PromptSubmission } from '@moonshot-ai/protocol';
import { IEventService, IPromptService, PromptService } from '@moonshot-ai/agent-core';

import { IRestGateway, startServer, type ServerStartOptions, type RunningServer } from '../src';
import { fixedTokenAuth } from './helpers/serverHarness';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let server: RunningServer | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-prompts-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-prompts-home-'));
});

afterEach(async () => {
  try {
    await server?.close();
  } catch {
    // ignore
  }
  server = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(bridgeHome, { recursive: true, force: true });
});

async function bootDaemon(
  serviceOverrides?: ServerStartOptions['serviceOverrides'],
): Promise<RunningServer> {
  server = await startServer({
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome },
    wsGatewayOptions: { pingIntervalMs: 5_000, pongTimeoutMs: 5_000 },
    serviceOverrides: [fixedTokenAuth(), ...(serviceOverrides ?? [])],
  });
  return server;
}

function appOf(r: RunningServer): {
  inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
} {
  const app = r.services.invokeFunction((a) => {
    const gw = a.get(IRestGateway);
    return gw.app as unknown as {
  inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
};
  });
  // Auto-attach the fixed bearer token so the M5.1 auth hook passes. A
  // caller-supplied `authorization` header wins, so explicit token tests keep
  // working; every other header (Range, content-type, …) is preserved.
  return {
    inject(req: unknown) {
      const q = req as { headers?: Record<string, string | string[] | undefined> };
      return app.inject({
        ...q,
        headers: { authorization: 'Bearer test-token', ...q.headers },
      });
    },
  };
}

function envelopeOf<T>(body: unknown): {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
  details?: unknown;
} {
  return body as {
    code: number;
    msg: string;
    data: T | null;
    request_id: string;
    details?: unknown;
  };
}

function createPromptServiceOverride(
  stub: Partial<IPromptService>,
): IPromptService {
  const noopComplete = (() => ({ dispose: () => undefined })) as IPromptService['onDidComplete'];
  const noopAbort = (() => ({ dispose: () => undefined })) as IPromptService['onDidAbort'];
  const defaultImpl: IPromptService = {
    _serviceBrand: undefined,
    list: async () => ({ active: null, queued: [] }),
    submit: async () => ({
      prompt_id: 'prompt_test',
      user_message_id: 'msg_test',
      status: 'running',
      content: [{ type: 'text', text: 'test' }],
      created_at: '2026-06-09T00:00:00.000Z',
    }),
    steer: async (_sid, promptIds) => ({
      steered: true,
      prompt_ids: [...promptIds],
    }),
    abort: async () => ({ aborted: true }),
    abortBySession: async () => ({ aborted: true }),
    getCurrentPromptId: () => undefined,
    applyAgentState: async () => undefined,
    getAgentStateSnapshot: () => undefined,
    startBtw: async () => 'prompt_btw_test',
    onDidComplete: noopComplete,
    onDidAbort: noopAbort,
  };
  return { ...defaultImpl, ...stub };
}

function buildMultipart(parts: {
  file: { fieldName: string; filename: string; contentType: string; data: Buffer };
  fields?: Array<{ name: string; value: string }>;
}): { body: Buffer; contentType: string } {
  const boundary = '------WebKitFormBoundaryKimiDaemonPromptTest';
  const lines: Array<Buffer | string> = [];
  if (parts.fields) {
    for (const field of parts.fields) {
      lines.push(`--${boundary}\r\n`);
      lines.push(
        `Content-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`,
      );
    }
  }
  lines.push(`--${boundary}\r\n`);
  lines.push(
    `Content-Disposition: form-data; name="${parts.file.fieldName}"; filename="${parts.file.filename}"\r\n`,
  );
  lines.push(`Content-Type: ${parts.file.contentType}\r\n\r\n`);
  lines.push(parts.file.data);
  lines.push(`\r\n--${boundary}--\r\n`);

  return {
    body: Buffer.concat(
      lines.map((line) => (typeof line === 'string' ? Buffer.from(line, 'utf8') : line)),
    ),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function wsDataToString(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return JSON.stringify(data);
}

const ONE_BY_ONE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

const TINY_MP4 = Buffer.from('fake mp4 video data');

async function createSession(r: RunningServer): Promise<string> {
  const res = await appOf(r).inject({
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { metadata: { cwd: join(tmpDir, 'workspace') } },
  });
  const env = envelopeOf<{ id: string }>(res.json());
  if (env.code !== 0 || env.data === null) {
    throw new Error(`create session failed: ${JSON.stringify(env)}`);
  }
  return env.data.id;
}

/**
 * Open a WS subscriber and wait for server_hello + client_hello ack.
 * Returns a handle exposing the received frame queue.
 *
 * Mirrors the queueing pattern from `ws-broadcast.e2e.test.ts` — message
 * listener is attached BEFORE the `open` event resolves, so frames that land
 * in the same tick as the upgrade aren't lost.
 */
async function openSubscriber(
  r: RunningServer,
  sid: string,
): Promise<{
  ws: WebSocket;
  received: Record<string, unknown>[];
}> {
  const wsUrl = r.address.replace('http://', 'ws://') + '/api/v1/ws';
  const received: Record<string, unknown>[] = [];
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const sock = new WebSocket(wsUrl, ['kimi-code.bearer.test-token']);
    sock.on('message', (data) => {
      try {
        received.push(JSON.parse(wsDataToString(data)) as Record<string, unknown>);
      } catch {
        // ignore
      }
    });
    sock.once('open', () => resolve(sock));
    sock.once('error', reject);
  });
  // Wait for server_hello.
  await waitFor(received, (f) => f['type'] === 'server_hello');
  ws.send(
    JSON.stringify({
      type: 'client_hello',
      id: 'h1',
      payload: { client_id: 'test', subscriptions: [sid] },
    }),
  );
  await waitFor(received, (f) => f['type'] === 'ack' && f['id'] === 'h1');
  return { ws, received };
}

async function waitFor(
  received: Record<string, unknown>[],
  pred: (f: Record<string, unknown>) => boolean,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = received.find(pred);
    if (hit !== undefined) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(
    `waitFor timed out; received: ${received.map((f) => f['type']).join(', ')}`,
  );
}

describe('POST /api/v1/sessions/{sid}/prompts — submit validation (W7.2 / Chain 4)', () => {
  it('rejects an empty content array with 40001', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts`,
      payload: { content: [] },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
    expect(env.data).toBeNull();
    expect(Array.isArray(env.details)).toBe(true);
  });

  it('returns 40401 for an unknown session id', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions/sess_missing/prompts',
      payload: {
        content: [{ type: 'text', text: 'hello' }],
        model: 'x',
        thinking: 'off',
        permission_mode: 'manual',
        plan_mode: false,
      },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40401);
  });

  it('rejects bad content shape with 40001 (no `type` field)', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts`,
      payload: { content: [{ text: 'no type' }] },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
  });

  it('submits image URL content without a file upload step', async () => {
    let submittedSid: string | undefined;
    let submitted: PromptSubmission | undefined;
    const r = await bootDaemon([
      [
        IPromptService,
        createPromptServiceOverride({
          submit: async (sessionId, body) => {
            submittedSid = sessionId;
            submitted = body;
            return {
              prompt_id: 'prompt_from_stub',
              user_message_id: 'msg_from_stub',
              status: 'running',
              content: body.content,
              created_at: '2026-06-09T00:00:00.000Z',
            };
          },
        }),
      ],
    ]);
    const sid = await createSession(r);

    const imageUrl = 'https://example.com/images/sample.png?size=full#frame';
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts`,
      payload: {
        content: [
          { type: 'text', text: 'describe this image' },
          {
            type: 'image',
            source: { kind: 'url', url: imageUrl },
          },
        ],
      },
    });
    const env = envelopeOf(res.json());
    expect(env.code).toBe(0);
    expect(submittedSid).toBe(sid);
    expect(submitted?.content).toEqual([
      { type: 'text', text: 'describe this image' },
      {
        type: 'image',
        source: { kind: 'url', url: imageUrl },
      },
    ]);
  });

  it('uploads a real PNG image file and resolves it before submitting the prompt', async () => {
    let submitted: PromptSubmission | undefined;
    const r = await bootDaemon([
      [
        IPromptService,
        createPromptServiceOverride({
          submit: async (_sid, body) => {
            submitted = body;
            return {
              prompt_id: 'prompt_from_stub',
              user_message_id: 'msg_from_stub',
              status: 'running',
              content: body.content,
              created_at: '2026-06-09T00:00:00.000Z',
            };
          },
        }),
      ],
    ]);
    const sid = await createSession(r);

    const upload = buildMultipart({
      file: {
        fieldName: 'file',
        filename: 'tiny.png',
        contentType: 'image/png',
        data: ONE_BY_ONE_PNG,
      },
    });
    const uploadRes = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/files',
      payload: upload.body,
      headers: { 'content-type': upload.contentType },
    });
    const uploadEnv = envelopeOf<{ id: string; media_type: string; size: number }>(
      uploadRes.json(),
    );
    expect(uploadEnv.code).toBe(0);
    expect(uploadEnv.data).not.toBeNull();
    expect(uploadEnv.data?.media_type).toBe('image/png');
    expect(uploadEnv.data?.size).toBe(ONE_BY_ONE_PNG.length);

    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts`,
      payload: {
        content: [
          { type: 'text', text: 'what is this?' },
          {
            type: 'image',
            source: { kind: 'file', file_id: uploadEnv.data!.id },
          },
        ],
      },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(0);
    expect(submitted?.content).toEqual([
      { type: 'text', text: 'what is this?' },
      {
        type: 'image',
        source: {
          kind: 'base64',
          media_type: 'image/png',
          data: ONE_BY_ONE_PNG.toString('base64'),
        },
      },
    ]);
  });

  it('compresses an oversized uploaded image when resolving the prompt, leaving the stored file intact', async () => {
    let submitted: PromptSubmission | undefined;
    const r = await bootDaemon([
      [
        IPromptService,
        createPromptServiceOverride({
          submit: async (_sid, body) => {
            submitted = body;
            return {
              prompt_id: 'prompt_from_stub',
              user_message_id: 'msg_from_stub',
              status: 'running',
              content: body.content,
              created_at: '2026-06-09T00:00:00.000Z',
            };
          },
        }),
      ],
    ]);
    const sid = await createSession(r);

    const bigPng = Buffer.from(
      await new Jimp({ width: 2600, height: 2600, color: 0x3366ccff }).getBuffer('image/png'),
    );
    const upload = buildMultipart({
      file: { fieldName: 'file', filename: 'big.png', contentType: 'image/png', data: bigPng },
    });
    const uploadRes = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/files',
      payload: upload.body,
      headers: { 'content-type': upload.contentType },
    });
    const uploadEnv = envelopeOf<{ id: string; media_type: string; size: number }>(
      uploadRes.json(),
    );
    expect(uploadEnv.code).toBe(0);
    // The stored file keeps its ORIGINAL bytes — only the prompt copy is shrunk.
    expect(uploadEnv.data?.size).toBe(bigPng.length);

    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts`,
      payload: {
        content: [{ type: 'image', source: { kind: 'file', file_id: uploadEnv.data!.id } }],
      },
    });
    expect(envelopeOf(res.json()).code).toBe(0);

    const part = submitted?.content[1];
    if (part?.type !== 'image' || part.source.kind !== 'base64') {
      throw new Error('expected a resolved base64 image part');
    }
    const sentBytes = Buffer.from(part.source.data, 'base64');
    const decoded = await Jimp.fromBuffer(sentBytes);
    // The model-facing copy is downsampled to the edge cap.
    expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(2000);

    // Compression is announced next to the image, and the caption points at
    // the stored file (which keeps the original bytes) for readback.
    const caption = submitted?.content[0];
    if (caption?.type !== 'text') {
      throw new Error('expected a compression caption before the image part');
    }
    expect(caption.text).toContain('Image compressed');
    expect(caption.text).toContain('2600x2600');
    const pathMatch = /saved at "([^"]+)"/.exec(caption.text);
    expect(pathMatch).not.toBeNull();
    const persisted = await readFile(pathMatch![1]!);
    expect(persisted.equals(bigPng)).toBe(true);
  });

  it('compresses an inline base64 image submitted directly in the prompt', async () => {
    let submitted: PromptSubmission | undefined;
    const r = await bootDaemon([
      [
        IPromptService,
        createPromptServiceOverride({
          submit: async (_sid, body) => {
            submitted = body;
            return {
              prompt_id: 'prompt_from_stub',
              user_message_id: 'msg_from_stub',
              status: 'running',
              content: body.content,
              created_at: '2026-06-09T00:00:00.000Z',
            };
          },
        }),
      ],
    ]);
    const sid = await createSession(r);

    // Solid 2600×2600: over the edge cap but tiny in bytes, so it stays well
    // under Fastify's inline-JSON limit yet still benefits from downscaling.
    const base64 = Buffer.from(
      await new Jimp({ width: 2600, height: 2600, color: 0x3366ccff }).getBuffer('image/png'),
    ).toString('base64');

    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts`,
      payload: {
        content: [
          { type: 'image', source: { kind: 'base64', media_type: 'image/png', data: base64 } },
        ],
      },
    });
    expect(envelopeOf(res.json()).code).toBe(0);

    const part = submitted?.content[1];
    if (part?.type !== 'image' || part.source.kind !== 'base64') {
      throw new Error('expected a base64 image part');
    }
    const decoded = await Jimp.fromBuffer(Buffer.from(part.source.data, 'base64'));
    expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(2000);

    // Inline base64 has no stored file, so the original is persisted into the
    // session's media-originals dir and the caption points there.
    const caption = submitted?.content[0];
    if (caption?.type !== 'text') {
      throw new Error('expected a compression caption before the image part');
    }
    expect(caption.text).toContain('Image compressed');
    const pathMatch = /saved at "([^"]+)"/.exec(caption.text);
    expect(pathMatch).not.toBeNull();
    // Session dirs live under the daemon home: <home>/sessions/<ws>/<id>.
    // (realpath both sides: macOS tmpdir is a /var → /private/var symlink.)
    const realHome = await realpath(bridgeHome);
    const realPersistedPath = await realpath(pathMatch![1]!);
    expect(realPersistedPath.startsWith(realHome)).toBe(true);
    expect(pathMatch![1]!).toContain('/media-originals/');
    const persisted = await readFile(pathMatch![1]!);
    expect(persisted.equals(Buffer.from(base64, 'base64'))).toBe(true);
  });

  it('returns 40407 when prompt image file_id is unknown', async () => {
    let submitted = false;
    const r = await bootDaemon([
      [
        IPromptService,
        createPromptServiceOverride({
          submit: async () => {
            submitted = true;
            return {
              prompt_id: 'prompt_from_stub',
              user_message_id: 'msg_from_stub',
              status: 'running',
              content: [{ type: 'text', text: 'stub' }],
              created_at: '2026-06-09T00:00:00.000Z',
            };
          },
        }),
      ],
    ]);
    const sid = await createSession(r);

    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts`,
      payload: {
        content: [
          {
            type: 'image',
            source: { kind: 'file', file_id: 'f_missing' },
          },
        ],
      },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40407);
    expect(submitted).toBe(false);
  });

  it('rejects non-image file_id content before submitting the prompt', async () => {
    let submitted = false;
    const r = await bootDaemon([
      [
        IPromptService,
        createPromptServiceOverride({
          submit: async () => {
            submitted = true;
            return {
              prompt_id: 'prompt_from_stub',
              user_message_id: 'msg_from_stub',
              status: 'running',
              content: [{ type: 'text', text: 'stub' }],
              created_at: '2026-06-09T00:00:00.000Z',
            };
          },
        }),
      ],
    ]);
    const sid = await createSession(r);

    const upload = buildMultipart({
      file: {
        fieldName: 'file',
        filename: 'note.txt',
        contentType: 'text/plain',
        data: Buffer.from('not an image'),
      },
    });
    const uploadRes = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/files',
      payload: upload.body,
      headers: { 'content-type': upload.contentType },
    });
    const uploadEnv = envelopeOf<{ id: string }>(uploadRes.json());
    expect(uploadEnv.code).toBe(0);
    expect(uploadEnv.data).not.toBeNull();

    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts`,
      payload: {
        content: [
          {
            type: 'image',
            source: { kind: 'file', file_id: uploadEnv.data!.id },
          },
        ],
      },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
    expect(submitted).toBe(false);
  });

  it('submits video URL content without a file upload step', async () => {
    let submittedSid: string | undefined;
    let submitted: PromptSubmission | undefined;
    const r = await bootDaemon([
      [
        IPromptService,
        createPromptServiceOverride({
          submit: async (sessionId, body) => {
            submittedSid = sessionId;
            submitted = body;
            return {
              prompt_id: 'prompt_from_stub',
              user_message_id: 'msg_from_stub',
              status: 'running',
              content: body.content,
              created_at: '2026-06-09T00:00:00.000Z',
            };
          },
        }),
      ],
    ]);
    const sid = await createSession(r);

    const videoUrl = 'https://example.com/videos/sample.mp4?size=full#frame';
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts`,
      payload: {
        content: [
          { type: 'text', text: 'describe this video' },
          {
            type: 'video',
            source: { kind: 'url', url: videoUrl },
          },
        ],
      },
    });
    const env = envelopeOf(res.json());
    expect(env.code).toBe(0);
    expect(submittedSid).toBe(sid);
    expect(submitted?.content).toEqual([
      { type: 'text', text: 'describe this video' },
      {
        type: 'video',
        source: { kind: 'url', url: videoUrl },
      },
    ]);
  });

  it('uploads a real video file and resolves it before submitting the prompt', async () => {
    let submitted: PromptSubmission | undefined;
    const r = await bootDaemon([
      [
        IPromptService,
        createPromptServiceOverride({
          submit: async (_sid, body) => {
            submitted = body;
            return {
              prompt_id: 'prompt_from_stub',
              user_message_id: 'msg_from_stub',
              status: 'running',
              content: body.content,
              created_at: '2026-06-09T00:00:00.000Z',
            };
          },
        }),
      ],
    ]);
    const sid = await createSession(r);

    const upload = buildMultipart({
      file: {
        fieldName: 'file',
        filename: 'tiny.mp4',
        contentType: 'video/mp4',
        data: TINY_MP4,
      },
    });
    const uploadRes = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/files',
      payload: upload.body,
      headers: { 'content-type': upload.contentType },
    });
    const uploadEnv = envelopeOf<{ id: string; media_type: string; size: number }>(
      uploadRes.json(),
    );
    expect(uploadEnv.code).toBe(0);
    expect(uploadEnv.data).not.toBeNull();
    expect(uploadEnv.data?.media_type).toBe('video/mp4');
    expect(uploadEnv.data?.size).toBe(TINY_MP4.length);

    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts`,
      payload: {
        content: [
          { type: 'text', text: 'what happens in this video?' },
          {
            type: 'video',
            source: { kind: 'file', file_id: uploadEnv.data!.id },
          },
        ],
      },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(0);
    // Video is NOT base64-inlined. It is materialized into the cache and
    // referenced by a `<video path="...">` tag so ReadMediaFile / the
    // provider's VideoUploader handle it, matching the TUI.
    const content = submitted?.content;
    expect(content).toHaveLength(2);
    expect(content?.[0]).toEqual({ type: 'text', text: 'what happens in this video?' });
    const videoPart = content?.[1] as { type: string; text: string } | undefined;
    expect(videoPart?.type).toBe('text');
    const match = /<video path="([^"]+)"><\/video>/.exec(videoPart?.text ?? '');
    expect(match).not.toBeNull();
    const cachePath = match![1]!;
    expect(cachePath.startsWith(join(bridgeHome, 'cache'))).toBe(true);
    expect(cachePath.endsWith('.mp4')).toBe(true);
    expect(existsSync(cachePath)).toBe(true);
    expect(readFileSync(cachePath).equals(TINY_MP4)).toBe(true);
  });

  it('rejects non-video file_id content before submitting the prompt', async () => {
    let submitted = false;
    const r = await bootDaemon([
      [
        IPromptService,
        createPromptServiceOverride({
          submit: async () => {
            submitted = true;
            return {
              prompt_id: 'prompt_from_stub',
              user_message_id: 'msg_from_stub',
              status: 'running',
              content: [{ type: 'text', text: 'stub' }],
              created_at: '2026-06-09T00:00:00.000Z',
            };
          },
        }),
      ],
    ]);
    const sid = await createSession(r);

    const upload = buildMultipart({
      file: {
        fieldName: 'file',
        filename: 'note.txt',
        contentType: 'text/plain',
        data: Buffer.from('not a video'),
      },
    });
    const uploadRes = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/files',
      payload: upload.body,
      headers: { 'content-type': upload.contentType },
    });
    const uploadEnv = envelopeOf<{ id: string }>(uploadRes.json());
    expect(uploadEnv.code).toBe(0);
    expect(uploadEnv.data).not.toBeNull();

    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts`,
      payload: {
        content: [
          {
            type: 'video',
            source: { kind: 'file', file_id: uploadEnv.data!.id },
          },
        ],
      },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
    expect(submitted).toBe(false);
  });
});

describe('Prompt queue and steer routes', () => {
  it('lists active and queued prompts', async () => {
    let sid: string | undefined;
    const r = await bootDaemon([
      [
        IPromptService,
        createPromptServiceOverride({
          list: async (sessionId) => {
            expect(sessionId).toBe(sid);
            return {
              active: {
                prompt_id: 'prompt_active',
                user_message_id: 'msg_active',
                status: 'running',
                content: [{ type: 'text', text: 'active' }],
                created_at: '2026-06-09T00:00:00.000Z',
              },
              queued: [
                {
                  prompt_id: 'prompt_queued',
                  user_message_id: 'msg_queued',
                  status: 'queued',
                  content: [{ type: 'text', text: 'queued' }],
                  created_at: '2026-06-09T00:00:01.000Z',
                },
              ],
            };
          },
        }),
      ],
    ]);
    sid = await createSession(r);

    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/prompts`,
    });
    const env = envelopeOf<{
      active: { prompt_id: string } | null;
      queued: Array<{ prompt_id: string }>;
    }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data?.active?.prompt_id).toBe('prompt_active');
    expect(env.data?.queued.map((p) => p.prompt_id)).toEqual(['prompt_queued']);
  });

  it('steers one queued prompt through the action suffix route', async () => {
    let sid: string | undefined;
    let steered: readonly string[] | undefined;
    const r = await bootDaemon([
      [
        IPromptService,
        createPromptServiceOverride({
          steer: async (sessionId, promptIds) => {
            expect(sessionId).toBe(sid);
            steered = promptIds;
            return { steered: true, prompt_ids: [...promptIds] };
          },
        }),
      ],
    ]);
    sid = await createSession(r);

    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts/prompt_queued:steer`,
    });
    const env = envelopeOf<{ steered: true; prompt_ids: string[] }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data?.prompt_ids).toEqual(['prompt_queued']);
    expect(steered).toEqual(['prompt_queued']);
  });

  it('steers multiple queued prompts through the collection action route', async () => {
    let sid: string | undefined;
    let steered: readonly string[] | undefined;
    const r = await bootDaemon([
      [
        IPromptService,
        createPromptServiceOverride({
          steer: async (sessionId, promptIds) => {
            expect(sessionId).toBe(sid);
            steered = promptIds;
            return { steered: true, prompt_ids: [...promptIds] };
          },
        }),
      ],
    ]);
    sid = await createSession(r);

    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts:steer`,
      payload: { prompt_ids: ['prompt_a', 'prompt_b'] },
    });
    const env = envelopeOf<{ steered: true; prompt_ids: string[] }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data?.prompt_ids).toEqual(['prompt_a', 'prompt_b']);
    expect(steered).toEqual(['prompt_a', 'prompt_b']);
  });
});

describe('Prompt lifecycle: WS receives events + synthesized prompt.completed (W7.2)', () => {
  it('broadcasts prompt.submitted events to session subscribers', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const { ws, received } = await openSubscriber(r, sid);

    const eventBus = r.services.invokeFunction((a) => a.get(IEventService));
    eventBus.publish({
      type: 'prompt.submitted',
      agentId: 'main',
      sessionId: sid,
      promptId: 'prompt_submit_test',
      userMessageId: 'msg_submit_test',
      status: 'running',
      content: [{ type: 'text', text: 'hello from client a' }],
      createdAt: '2026-06-11T00:00:00.000Z',
    });

    const submittedFrame = await waitFor(
      received,
      (f) => f['type'] === 'prompt.submitted',
      2000,
    );
    expect(submittedFrame['session_id']).toBe(sid);
    expect(submittedFrame['payload']).toMatchObject({
      promptId: 'prompt_submit_test',
      userMessageId: 'msg_submit_test',
      content: [{ type: 'text', text: 'hello from client a' }],
    });

    ws.close();
  });

  it('synthesizes prompt.completed end-to-end through bus → observer → WS', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const { ws, received } = await openSubscriber(r, sid);

    const promptId = `prompt_TEST_${sid}`;
    const turnId = 42;

    // Inject an active-prompt record into the server's IPromptService so the
    // lifecycle observer recognizes turn.* events for this session. We skip
    // a real `bridge.rpc.prompt(...)` call because it would require provider
    // credentials + a fully-loaded agent.
    const impl = r.services.invokeFunction(
      (a) => a.get(IPromptService) as PromptService,
    );
    expect(impl).toBeInstanceOf(PromptService);
    impl._injectActiveForTest(sid, promptId, null);

    // Publish the agent-core event stream directly through the bus.
    const eventBus = r.services.invokeFunction((a) => a.get(IEventService));
    eventBus.publish({
      type: 'turn.started',
      turnId,
      origin: { kind: 'user' },
      sessionId: sid,
      agentId: 'main',
    } as unknown as Event);
    eventBus.publish({
      type: 'assistant.delta',
      turnId,
      delta: 'hi ',
      sessionId: sid,
      agentId: 'main',
    } as unknown as Event);
    eventBus.publish({
      type: 'assistant.delta',
      turnId,
      delta: 'there',
      sessionId: sid,
      agentId: 'main',
    } as unknown as Event);
    eventBus.publish({
      type: 'turn.ended',
      turnId,
      reason: 'completed',
      sessionId: sid,
      agentId: 'main',
    } as unknown as Event);

    // Wait for the synthesized prompt.completed event on the WS.
    const promptCompletedFrame = await waitFor(
      received,
      (f) => f['type'] === 'prompt.completed',
      2000,
    );
    const payload = promptCompletedFrame['payload'] as {
      promptId: string;
      reason: string;
    };
    expect(payload.promptId).toBe(promptId);
    expect(payload.reason).toBe('completed');
    expect(promptCompletedFrame['session_id']).toBe(sid);

    // Verify the upstream events also arrived in order.
    const types = received.map((f) => f['type']);
    expect(types).toContain('turn.started');
    expect(types).toContain('assistant.delta');
    expect(types).toContain('turn.ended');
    expect(types).toContain('prompt.completed');
    // prompt.completed lands AFTER turn.ended (synthesized post-fan-out).
    const turnEndedIdx = types.lastIndexOf('turn.ended');
    const completedIdx = types.lastIndexOf('prompt.completed');
    expect(completedIdx).toBeGreaterThan(turnEndedIdx);

    ws.close();
  });

  it('synthesizes prompt.aborted when turn.ended (reason=cancelled) fires', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const { ws, received } = await openSubscriber(r, sid);

    const promptId = `prompt_ABORT_TEST_${sid}`;
    const turnId = 7;

    const impl = r.services.invokeFunction(
      (a) => a.get(IPromptService) as PromptService,
    );
    impl._injectActiveForTest(sid, promptId, null);

    const eventBus = r.services.invokeFunction((a) => a.get(IEventService));
    eventBus.publish({
      type: 'turn.started',
      turnId,
      origin: { kind: 'user' },
      sessionId: sid,
      agentId: 'main',
    } as unknown as Event);
    eventBus.publish({
      type: 'turn.ended',
      turnId,
      reason: 'cancelled',
      sessionId: sid,
      agentId: 'main',
    } as unknown as Event);

    const abortedFrame = await waitFor(
      received,
      (f) => f['type'] === 'prompt.aborted',
      2000,
    );
    const payload = abortedFrame['payload'] as { promptId: string };
    expect(payload.promptId).toBe(promptId);

    ws.close();
  });
});

describe('POST /api/v1/sessions/{sid}:abort — session-level cancel', () => {
  it('cancels an active daemon prompt', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);

    const promptId = `prompt_SESSION_ABORT_${sid}`;
    const turnId = 9;
    const impl = r.services.invokeFunction(
      (a) => a.get(IPromptService) as PromptService,
    );
    impl._injectActiveForTest(sid, promptId, turnId);

    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}:abort`,
    });
    const env = envelopeOf<{ aborted: boolean }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data).toEqual({ aborted: true });
  });

  it('cancels a non-prompt turn (skill activation) without requiring prompt_id', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);

    // Publish a running turn without creating a daemon prompt.
    const eventBus = r.services.invokeFunction((a) => a.get(IEventService));
    eventBus.publish({
      type: 'turn.started',
      turnId: 3,
      origin: { kind: 'skill_activation', skillName: 'demo', activationId: 'act_1' },
      sessionId: sid,
      agentId: 'main',
    } as unknown as Event);

    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}:abort`,
    });
    const env = envelopeOf<{ aborted: boolean }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data).toEqual({ aborted: true });
  });

  it('returns 40401 for an unknown session id', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions/sess_missing:abort',
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40401);
  });
});
