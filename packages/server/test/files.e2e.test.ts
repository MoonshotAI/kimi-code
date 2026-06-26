/**
 * `/api/v1/files` end-to-end (W12.2 / Chain 15, P1.15).
 *
 * AC coverage (ROADMAP §Chain 15):
 *   1. upload → file_id → GET stream → DELETE → re-GET → 40407
 *   2. upload > 50MB → 41301
 *   3. file_id 不存在 → 40407
 *
 * We test via `app.inject` (Fastify in-process HTTP) to drive multipart
 * uploads — much simpler than spinning a real HTTP client. The
 * multipart body is hand-constructed via `form-data`-style boundary
 * frames.
 */

import {
  mkdtempSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  IRestGateway,
  startServer,
  type RunningServer,
} from '../src';
import { fixedTokenAuth } from './helpers/serverHarness';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let server: RunningServer | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-files-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-files-home-'));
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

async function bootDaemon(): Promise<RunningServer> {
  server = await startServer({
    serviceOverrides: [fixedTokenAuth()],
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome },
  });
  return server;
}

interface InjectResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  payload: Buffer;
  rawPayload: Buffer;
  json: () => unknown;
}

interface FastifyAppLike {
  inject: (req: unknown) => Promise<InjectResponse>;
}

function appOf(r: RunningServer): FastifyAppLike {
  const app = r.services.invokeFunction((a) => {
    const gw = a.get(IRestGateway);
    return gw.app as unknown as FastifyAppLike;
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

interface Envelope<T = unknown> {
  code: number;
  msg: string;
  data: T | null;
  request_id?: string;
  details?: unknown;
}

/**
 * Build a `multipart/form-data` body with one file part and optional
 * additional field parts. Returns `{body, contentType}`. The boundary
 * is a fixed string so tests are deterministic.
 */
function buildMultipart(parts: {
  file: { fieldName: string; filename: string; contentType: string; data: Buffer };
  fields?: Array<{ name: string; value: string }>;
}): { body: Buffer; contentType: string } {
  const boundary = '------WebKitFormBoundaryKimiDaemonTest';
  const lines: Array<Buffer | string> = [];
  // Field parts FIRST (busboy reads them before the file in order).
  if (parts.fields) {
    for (const f of parts.fields) {
      lines.push(`--${boundary}\r\n`);
      lines.push(
        `Content-Disposition: form-data; name="${f.name}"\r\n\r\n${f.value}\r\n`,
      );
    }
  }
  // File part.
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

describe('POST /api/v1/files (W12.2 / Chain 15)', () => {
  it('AC #1: upload tiny file → file_id → GET stream matches → DELETE → re-GET 40407', async () => {
    const r = await bootDaemon();
    const data = Buffer.from('hello server files');
    const mp = buildMultipart({
      file: {
        fieldName: 'file',
        filename: 'hello.txt',
        contentType: 'text/plain',
        data,
      },
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
    expect(upEnv.data).not.toBeNull();
    const meta = upEnv.data!;
    expect(meta.name).toBe('hello.txt');
    expect(meta.media_type).toBe('text/plain');
    expect(meta.size).toBe(data.length);

    // Verify blob is on disk under bridgeHome/files/<id>
    const blobPath = join(bridgeHome, 'files', meta.id);
    expect(readFileSync(blobPath)).toEqual(data);

    // GET should return the bytes with octet-stream-or-mime body.
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

    // DELETE.
    const delRes = await appOf(r).inject({
      method: 'DELETE',
      url: `/api/v1/files/${meta.id}`,
    });
    expect(delRes.statusCode).toBe(200);
    const delEnv = delRes.json() as Envelope<{ deleted: true }>;
    expect(delEnv.code).toBe(0);
    expect(delEnv.data?.deleted).toBe(true);

    // GET after delete → 40407.
    const get2Res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/files/${meta.id}`,
    });
    expect(get2Res.statusCode).toBe(404);
    expect(get2Res.headers['content-type']).toMatch(/application\/json/);
    const env404 = get2Res.json() as Envelope;
    expect(env404.code).toBe(40407);
  });

  it('AC #2: upload > 50MB → 41301', async () => {
    const r = await bootDaemon();
    // 51 MB of zeros.
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
    expect(res.statusCode).toBe(413);
    const env = res.json() as Envelope;
    expect(env.code).toBe(41301);
  });

  it('AC #3: GET / DELETE unknown file_id → 40407', async () => {
    const r = await bootDaemon();
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

  it.skipIf(process.platform === 'win32')('survives server restart: index.json persists upload across instances', async () => {
    // Upload under server #1.
    let r = await bootDaemon();
    const data = Buffer.from('persistent payload');
    const mp = buildMultipart({
      file: {
        fieldName: 'file',
        filename: 'persist.txt',
        contentType: 'text/plain',
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
    expect(meta.id).toBeDefined();

    // Restart server (same homeDir, fresh process state).
    await r.close();
    server = undefined;
    r = await bootDaemon();

    const getRes = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/files/${meta.id}`,
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.rawPayload).toEqual(data);
  });

  it('honors the multipart `name` field override', async () => {
    const r = await bootDaemon();
    const data = Buffer.from('renamed payload');
    const mp = buildMultipart({
      file: {
        fieldName: 'file',
        filename: 'original.txt',
        contentType: 'text/plain',
        data,
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
    const env = res.json() as Envelope<{ name: string }>;
    expect(env.data?.name).toBe('overridden.txt');
  });

  it('missing file part → 40001 validation error', async () => {
    const r = await bootDaemon();
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
    // We send `{code:40001}` envelope — the body has no `file` field.
    expect(res.statusCode).toBe(200);
    const env = res.json() as Envelope;
    expect(env.code).toBe(40001);
  });
});
