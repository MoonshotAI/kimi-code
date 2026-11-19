import { describe, it, expect, vi } from 'vitest';

import { createServerLogStream, serverLogPayload } from '../../../src/main/server/server-log';

vi.mock('electron', () => ({ app: { isPackaged: true }, dialog: { showErrorBox: vi.fn() } }));
vi.mock('@moonshot-ai/kap-server', () => ({ createServerLogger: vi.fn() }));

function pinoLine(record: Record<string, unknown>): string {
  return `${JSON.stringify({ time: '2026-10-29T00:00:00.000Z', name: 'kimi-server-v2', pid: 1, hostname: 'h', ...record })}\n`;
}

describe('serverLogPayload', () => {
  it('keeps warn and error records with their structured fields', () => {
    expect(serverLogPayload(pinoLine({ level: 40, msg: 'ws upgrade rejected', reason: 'origin_not_allowed' }))).toEqual({
      level: 'warn',
      message: 'ws upgrade rejected',
      detail: { reason: 'origin_not_allowed' },
    });
    expect(serverLogPayload(pinoLine({ level: 60, msg: 'uncaughtException', err: { type: 'Error', message: 'boom' } }))).toEqual({
      level: 'error',
      message: 'uncaughtException',
      detail: { err: { type: 'Error', message: 'boom' } },
    });
  });

  it('drops info-level and malformed records', () => {
    expect(serverLogPayload(pinoLine({ level: 30, msg: 'listening' }))).toBeNull();
    expect(serverLogPayload('not json')).toBeNull();
    expect(serverLogPayload('[1,2]')).toBeNull();
    expect(serverLogPayload(pinoLine({ msg: 'no level' }))).toBeNull();
  });

  it('labels records without a message and omits empty detail', () => {
    expect(serverLogPayload(pinoLine({ level: 50 }))).toEqual({ level: 'error', message: '(no message)' });
  });
});

describe('createServerLogStream', () => {
  it('forwards warn+ records and mirrors every chunk when asked', () => {
    const forward = vi.fn();
    const mirror = vi.fn();
    const stream = createServerLogStream(forward, mirror);
    const info = pinoLine({ level: 30, msg: 'request completed' });
    const warn = pinoLine({ level: 40, msg: 'session index prepare failed', err: 'EACCES' });
    stream.write(info);
    stream.write(warn);
    expect(mirror).toHaveBeenNthCalledWith(1, info);
    expect(mirror).toHaveBeenNthCalledWith(2, warn);
    expect(forward).toHaveBeenCalledOnce();
    expect(forward).toHaveBeenCalledWith({ level: 'warn', message: 'session index prepare failed', detail: { err: 'EACCES' } });
  });

  it('writes server lines through the sanitizing writer with a [server] prefix', async () => {
    const { createRendererLogWriter } = await import('../../../src/main/diagnostics/renderer-log');
    const lines: string[] = [];
    const stream = createServerLogStream(createRendererLogWriter((_level, line) => lines.push(line), Date.now, 'server'));
    stream.write(pinoLine({ level: 40, msg: 'ws upgrade rejected', path: '/api/v1/ws?token=secret-value' }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[server\] ws upgrade rejected {2}\{"path":"\/api\/v1\/ws\?token=\[redacted\]"\}$/);
  });
});
