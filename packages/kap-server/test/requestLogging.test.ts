import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { pino, type Logger } from 'pino';
import { afterEach, assert, describe, expect, it } from 'vitest';

import { extractEnvelopeCode } from '../src/requestLogging';
import { type RunningServer, startServer } from '../src/start';

function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { logger: pino({ level: 'info' }, stream), lines };
}

function parseEntries(lines: string[]): Record<string, unknown>[] {
  return lines
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

describe('requestLogging', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('logs the envelope code instead of the HTTP status code', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-request-log-'));
    const { logger, lines } = captureLogger();
    server = await startServer({ host: '127.0.0.1', port: 0, homeDir: home, logger });

    const res = await fetch(`http://127.0.0.1:${String(server.port)}/api/v1/healthz`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { code: number }).code).toBe(0);

    // Let the post-response `onResponse` hook flush its log line.
    await new Promise((resolve) => setImmediate(resolve));

    const completed = parseEntries(lines).filter((entry) => entry['msg'] === 'request completed');
    expect(completed.length).toBeGreaterThanOrEqual(1);
    const entry = completed[completed.length - 1];
    assert(entry !== undefined);

    // The access line carries the envelope `code`, not the HTTP status code.
    expect(entry['code']).toBe(0);
    expect(entry).not.toHaveProperty('statusCode');
    expect(entry['res']).toBeUndefined();
    expect(entry['req']).toMatchObject({ method: 'GET', url: '/api/v1/healthz' });
    expect(typeof entry['responseTime']).toBe('number');
  });
});

describe('extractEnvelopeCode', () => {
  it('extracts a leading code from an envelope body', () => {
    expect(extractEnvelopeCode('{"code":0,"msg":"success","data":null,"request_id":"r"}')).toBe(0);
    expect(
      extractEnvelopeCode('{"code":40001,"msg":"validation.failed","data":null,"request_id":"r"}'),
    ).toBe(40001);
  });

  it('returns undefined for non-envelope or non-string payloads', () => {
    expect(extractEnvelopeCode(undefined)).toBeUndefined();
    expect(extractEnvelopeCode(Buffer.from('{"code":1}'))).toBeUndefined();
    expect(extractEnvelopeCode('<html/>')).toBeUndefined();
    expect(extractEnvelopeCode('{"msg":"no code"}')).toBeUndefined();
  });
});
