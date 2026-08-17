/**
 * `/api/v1/files` and session-canonical media downloads end-to-end for the v2 server.
 *
 * Mirrors the v1 server's files e2e (upload → download → delete → 404,
 * large uploads with no size cap, unknown ids, index persistence across
 * restart, the `name` override, and the missing-file validation) but boots
 * `startServer` from server-v2 and drives it through Fastify `app.inject`
 * with hand-built multipart bodies.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getLiveSessionById,
  IFileService,
  ISessionManager,
  ISessionMediaStore,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

let home: string;
let server: RunningServer | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kimi-server-v2-files-'));
});

afterEach(async () => {
  try {
    await server?.close();
  } catch {
    // ignore
  }
  server = undefined;
  rmSync(home, { recursive: true, force: true });
});

async function boot(): Promise<RunningServer> {
  server = await startServer({
    hostIdentity: TEST_HOST_IDENTITY,
    host: '127.0.0.1',
    port: 0,
    homeDir: home,
    logLevel: 'silent',
  });
  return server;
}

interface InjectResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  payload: string;
  rawPayload: Buffer;
  json: () => unknown;
}

interface AppLike {
  inject: (req: unknown) => Promise<InjectResponse>;
}

function appOf(r: RunningServer): AppLike {
  const app = r.app as unknown as AppLike;
  return {
    inject(req: unknown): Promise<InjectResponse> {
      const request = req as { headers?: Record<string, string> };
      return app.inject({
        ...request,
        headers: {
          ...request.headers,
          authorization: `Bearer ${r.authTokenService.getToken()}`,
        },
      });
    },
  };
}

interface Envelope<T = unknown> {
  code: number;
  msg: string;
  data: T | null;
  request_id?: string;
  details?: unknown;
}

function buildMultipart(parts: {
  file: { fieldName: string; filename: string; contentType: string; data: Buffer };
  fields?: Array<{ name: string; value: string }>;
}): { body: Buffer; contentType: string } {
  const boundary = '------WebKitFormBoundaryKimiServerV2Test';
  const lines: Array<Buffer | string> = [];
  if (parts.fields) {
    for (const f of parts.fields) {
      lines.push(`--${boundary}\r\n`);
      lines.push(`Content-Disposition: form-data; name="${f.name}"\r\n\r\n${f.value}\r\n`);
    }
  }
  lines.push(`--${boundary}\r\n`);
  lines.push(
    `Content-Disposition: form-data; name="${parts.file.fieldName}"; filename="${parts.file.filename}"\r\n`,
  );
  lines.push(`Content-Type: ${parts.file.contentType}\r\n\r\n`);
  lines.push(parts.file.data);
  lines.push(`\r\n--${boundary}--\r\n`);

  const chunks: Buffer[] = [];
  for (const ln of lines) {
    chunks.push(typeof ln === 'string' ? Buffer.from(ln, 'utf8') : ln);
  }
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function createSession(r: RunningServer): Promise<string> {
  const res = await appOf(r).inject({
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { metadata: { cwd: home } },
    headers: { 'content-type': 'application/json' },
  });
  const envelope = res.json() as Envelope<{ id: string }>;
  if (envelope.code !== 0 || envelope.data === null) {
    throw new Error(`failed to create session: ${res.body}`);
  }
  return envelope.data.id;
}

async function uploadFile(
  r: RunningServer,
  data: Buffer,
  name: string,
  mediaType: string,
): Promise<{ id: string; name: string; media_type: string; size: number }> {
  const multipart = buildMultipart({
    file: { fieldName: 'file', filename: name, contentType: mediaType, data },
  });
  const res = await appOf(r).inject({
    method: 'POST',
    url: '/api/v1/files',
    payload: multipart.body,
    headers: { 'content-type': multipart.contentType },
  });
  const envelope = res.json() as Envelope<{
    id: string;
    name: string;
    media_type: string;
    size: number;
  }>;
  if (envelope.code !== 0 || envelope.data === null) {
    throw new Error(`failed to upload file: ${res.body}`);
  }
  return envelope.data;
}

async function materializeUploadedFile(
  r: RunningServer,
  sessionId: string,
  meta: { id: string; name: string; media_type: string; size: number },
): Promise<void> {
  const session = getLiveSessionById(r.core.accessor, sessionId);
  if (session === undefined) throw new Error(`session ${sessionId} is not live`);
  const uploaded = await r.core.accessor.get(IFileService).get(meta.id);
  await session.accessor.get(ISessionMediaStore).materialize({
    fileId: meta.id,
    name: meta.name,
    mimeType: meta.media_type,
    size: meta.size,
    stream: () => uploaded.stream(),
  });
}

describe('POST /api/v1/files (server-v2)', () => {
  it('upload → GET stream → DELETE → re-GET 40407', async () => {
    const r = await boot();
    const data = Buffer.from('hello server v2 files');
    const mp = buildMultipart({
      file: { fieldName: 'file', filename: 'hello.txt', contentType: 'text/plain', data },
    });

    const upRes = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/files',
      payload: mp.body,
      headers: { 'content-type': mp.contentType },
    });
    expect(upRes.statusCode).toBe(200);
    const upEnv = upRes.json() as Envelope<{
      id: string;
      name: string;
      media_type: string;
      size: number;
      created_at: string;
    }>;
    expect(upEnv.code).toBe(0);
    const meta = upEnv.data!;
    expect(meta.name).toBe('hello.txt');
    expect(meta.media_type).toBe('text/plain');
    expect(meta.size).toBe(data.length);

    const getRes = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/files/${meta.id}`,
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.headers['content-type']).toBe('text/plain');
    expect(getRes.headers['content-length']).toBe(String(data.length));
    expect(getRes.headers['etag']).toBe(`"${meta.id}-${meta.size}"`);
    expect(String(getRes.headers['content-disposition'])).toMatch(
      /attachment; filename="hello\.txt"/,
    );
    expect(getRes.rawPayload).toEqual(data);

    const delRes = await appOf(r).inject({
      method: 'DELETE',
      url: `/api/v1/files/${meta.id}`,
    });
    expect(delRes.statusCode).toBe(200);
    const delEnv = delRes.json() as Envelope<{ deleted: true }>;
    expect(delEnv.code).toBe(0);
    expect(delEnv.data?.deleted).toBe(true);

    const get2Res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/files/${meta.id}`,
    });
    expect(get2Res.statusCode).toBe(404);
    expect((get2Res.json() as Envelope).code).toBe(40407);
  });

  it('uploads a file larger than the former 50 MiB cap', async () => {
    const r = await boot();
    const big = Buffer.alloc(51 * 1024 * 1024, 0);
    const mp = buildMultipart({
      file: {
        fieldName: 'file',
        filename: 'big.bin',
        contentType: 'application/octet-stream',
        data: big,
      },
    });
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/files',
      payload: mp.body,
      headers: { 'content-type': mp.contentType },
    });
    expect(res.statusCode).toBe(200);
    const env = res.json() as Envelope<{ id: string; size: number }>;
    expect(env.code).toBe(0);
    expect(env.data!.size).toBe(big.length);

    const getRes = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/files/${env.data!.id}`,
    });
    expect(getRes.statusCode).toBe(200);
    // `expect(buffer).toEqual(buffer)` deep-compares 51M elements and blows
    // the heap — use the native memcmp instead.
    expect(getRes.rawPayload.equals(big)).toBe(true);
  });

  it('GET / DELETE unknown file_id → 40407', async () => {
    const r = await boot();
    const getRes = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/files/f_does_not_exist',
    });
    expect(getRes.statusCode).toBe(404);
    expect((getRes.json() as Envelope).code).toBe(40407);

    const delRes = await appOf(r).inject({
      method: 'DELETE',
      url: '/api/v1/files/f_does_not_exist',
    });
    expect(delRes.statusCode).toBe(404);
    expect((delRes.json() as Envelope).code).toBe(40407);
  });

  it('survives a server restart (index + blob persist)', async () => {
    let r = await boot();
    const data = Buffer.from('persistent payload');
    const mp = buildMultipart({
      file: { fieldName: 'file', filename: 'persist.txt', contentType: 'text/plain', data },
    });
    const upRes = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/files',
      payload: mp.body,
      headers: { 'content-type': mp.contentType },
    });
    const meta = (upRes.json() as Envelope<{ id: string; size: number }>).data!;
    expect(meta.id).toBeDefined();

    await r.close();
    server = undefined;
    r = await boot();

    const getRes = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/files/${meta.id}`,
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.rawPayload).toEqual(data);
  });

  it('honors the multipart `name` field override', async () => {
    const r = await boot();
    const mp = buildMultipart({
      file: {
        fieldName: 'file',
        filename: 'original.txt',
        contentType: 'text/plain',
        data: Buffer.from('renamed payload'),
      },
      fields: [{ name: 'name', value: 'overridden.txt' }],
    });
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/files',
      payload: mp.body,
      headers: { 'content-type': mp.contentType },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Envelope<{ name: string }>).data?.name).toBe('overridden.txt');
  });

  it('serves byte ranges with 206 Partial Content for video playback', async () => {
    const r = await boot();
    const data = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
    const mp = buildMultipart({
      file: {
        fieldName: 'file',
        filename: 'clip.mp4',
        contentType: 'video/mp4',
        data,
      },
    });
    const upRes = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/files',
      payload: mp.body,
      headers: { 'content-type': mp.contentType },
    });
    const meta = (upRes.json() as Envelope<{ id: string; size: number }>).data!;

    const full = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/files/${meta.id}`,
    });
    expect(full.statusCode).toBe(200);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['content-type']).toBe('video/mp4');
    expect(String(full.headers['content-disposition'])).toMatch(/^inline;/);
    expect(full.rawPayload).toEqual(data);

    const part = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/files/${meta.id}`,
      headers: { range: 'bytes=4-9' },
    });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 4-9/${data.length}`);
    expect(part.headers['content-length']).toBe('6');
    expect(part.rawPayload).toEqual(data.subarray(4, 10));

    const tail = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/files/${meta.id}`,
      headers: { range: 'bytes=30-' },
    });
    expect(tail.statusCode).toBe(206);
    expect(tail.headers['content-range']).toBe(`bytes 30-${data.length - 1}/${data.length}`);
    expect(tail.rawPayload).toEqual(data.subarray(30));
  });

  it('missing file part → 40001 validation error', async () => {
    const r = await boot();
    const boundary = '------WebKitFormBoundaryNoFile';
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="other"\r\n\r\nhi\r\n--${boundary}--\r\n`,
      'utf8',
    );
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/files',
      payload: body,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Envelope).code).toBe(40001);
  });
});

describe('GET /api/v1/sessions/{session_id}/media/{file_id} (server-v2)', () => {
  it('serves the session copy after the transient upload is deleted', async () => {
    const r = await boot();
    const data = Buffer.from('canonical image bytes');
    const sessionId = await createSession(r);
    const meta = await uploadFile(r, data, 'pasted image.png', 'image/png');
    await materializeUploadedFile(r, sessionId, meta);

    await appOf(r).inject({ method: 'DELETE', url: `/api/v1/files/${meta.id}` });
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/media/${meta.id}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-length']).toBe(String(data.length));
    expect(String(res.headers['content-disposition'])).toMatch(
      /inline; filename="pasted image\.png"/,
    );
    expect(res.rawPayload).toEqual(data);
  });

  it('serves the staged upload before intake materializes the session copy', async () => {
    const r = await boot();
    const data = Buffer.from('staged upload bytes');
    const sessionId = await createSession(r);
    const meta = await uploadFile(r, data, 'staged.png', 'image/png');

    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/media/${meta.id}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-length']).toBe(String(data.length));
    expect(res.rawPayload).toEqual(data);
  });

  it('returns file-not-found when neither the session store nor the staged upload holds it', async () => {
    const r = await boot();
    const sessionId = await createSession(r);

    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/media/f_does_not_exist`,
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as Envelope).code).toBe(40407);
  });

  it('serves a requested byte range from the session copy', async () => {
    const r = await boot();
    const data = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
    const sessionId = await createSession(r);
    const meta = await uploadFile(r, data, 'clip.mp4', 'video/mp4');
    await materializeUploadedFile(r, sessionId, meta);

    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/media/${meta.id}`,
      headers: { range: 'bytes=4-9' },
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['content-range']).toBe(`bytes 4-9/${data.length}`);
    expect(res.headers['content-length']).toBe('6');
    expect(res.rawPayload).toEqual(data.subarray(4, 10));
  });

  it('serves the session copy after a server restart', async () => {
    let r = await boot();
    const data = Buffer.from('restart-safe media');
    const sessionId = await createSession(r);
    const meta = await uploadFile(r, data, 'restart.png', 'image/png');
    await materializeUploadedFile(r, sessionId, meta);
    await appOf(r).inject({ method: 'DELETE', url: `/api/v1/files/${meta.id}` });

    await r.close();
    server = undefined;
    r = await boot();
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/media/${meta.id}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload).toEqual(data);
  });

  it('serves the copied media from a forked session', async () => {
    const r = await boot();
    const data = Buffer.from('forked media');
    const sessionId = await createSession(r);
    const meta = await uploadFile(r, data, 'fork.png', 'image/png');
    await materializeUploadedFile(r, sessionId, meta);
    const fork = await r.core.accessor.get(ISessionManager).fork({
      sourceSessionId: sessionId,
    });

    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${fork.id}/media/${meta.id}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(String(res.headers['content-disposition'])).toMatch(/filename="fork\.png"/);
    expect(res.rawPayload).toEqual(data);
  });

  it('returns session-not-found after the owning session is deleted', async () => {
    const r = await boot();
    const data = Buffer.from('delete-owned media');
    const sessionId = await createSession(r);
    const meta = await uploadFile(r, data, 'delete.png', 'image/png');
    await materializeUploadedFile(r, sessionId, meta);
    await r.core.accessor.get(ISessionManager).delete(sessionId);

    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/media/${meta.id}`,
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as Envelope).code).toBe(40401);
  });
});
