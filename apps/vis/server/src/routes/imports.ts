import { Hono } from 'hono';

import { KIMI_CODE_HOME } from '../config';
import { importSessionZip } from '../lib/import-store';
import { ZipImportError } from '../lib/zip-import';

const MAX_ZIP_BYTES = 500 * 1024 * 1024;

export function importsRoute(home: string = KIMI_CODE_HOME): Hono {
  const r = new Hono();

  r.post('/', async (c) => {
    const declared = Number(c.req.header('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_ZIP_BYTES) {
      return c.json({ error: 'zip is too large', code: 'BAD_REQUEST' }, 400);
    }
    const name = c.req.query('name') ?? null;
    let buffer: Buffer;
    try {
      buffer = Buffer.from(await c.req.arrayBuffer());
    } catch {
      return c.json({ error: 'could not read upload body', code: 'BAD_REQUEST' }, 400);
    }
    if (buffer.length === 0) {
      return c.json({ error: 'empty upload', code: 'BAD_REQUEST' }, 400);
    }
    if (buffer.length > MAX_ZIP_BYTES) {
      return c.json({ error: 'zip is too large', code: 'BAD_REQUEST' }, 400);
    }
    try {
      const meta = await importSessionZip(home, buffer, name, new Date());
      return c.json({ sessionId: meta.importId, importMeta: meta });
    } catch (error) {
      if (error instanceof ZipImportError) {
        return c.json({ error: error.message, code: 'BAD_REQUEST' }, 400);
      }
      return c.json({ error: (error as Error).message, code: 'READ_ERROR' }, 500);
    }
  });

  return r;
}
