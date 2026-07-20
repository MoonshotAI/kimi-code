import { describe, expect, it } from 'vitest';

import {
  CTX_VALUE_MAX_CHARS,
  ENTRY_MAX_BYTES,
  MSG_MAX_CHARS,
  STACK_MAX_BYTES,
  extractError,
  formatEntry,
  redactCtx,
} from '#/_base/log/formatter';
import type { LogEntry } from '#/_base/log/log';

const FIXED_TIME = Date.UTC(2026, 4, 19, 10, 12, 30, 123);

function baseEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    t: FIXED_TIME,
    level: 'info',
    msg: 'diagnostic event',
    ...overrides,
  };
}

describe('formatter — logfmt rendering', () => {
  it('renders timestamp, level, msg without ctx', () => {
    const { text } = formatEntry(baseEntry());
    expect(text).toBe('2026-05-19T10:12:30.123Z INFO  diagnostic event');
  });

  it('renders ctx as k=v pairs', () => {
    const { text } = formatEntry(
      baseEntry({ ctx: { sessionId: 'ses_abc', workDir: '/repo' } }),
    );
    expect(text).toContain('sessionId=ses_abc');
    expect(text).toContain('workDir=/repo');
  });

  it('omits selected ctx keys', () => {
    const { text } = formatEntry(
      baseEntry({ ctx: { sessionId: 'ses_abc', workDir: '/repo' } }),
      { omitContextKeys: ['sessionId'] },
    );
    expect(text).not.toContain('sessionId=ses_abc');
    expect(text).toContain('workDir=/repo');
  });

  it('quotes ctx values that contain spaces or special chars', () => {
    const { text } = formatEntry(baseEntry({ ctx: { path: '/Users/foo bar/x' } }));
    expect(text).toContain('path="/Users/foo bar/x"');
  });

  it('renders all level labels at fixed width', () => {
    for (const level of ['error', 'warn', 'info', 'debug'] as const) {
      const { text } = formatEntry(baseEntry({ level }));
      const label =
        level === 'error' ? 'ERROR' : level === 'warn' ? 'WARN ' : level === 'info' ? 'INFO ' : 'DEBUG';
      expect(text).toContain(` ${label} `);
    }
  });

  it('does not include ANSI when ansi=false', () => {
    const { text } = formatEntry(baseEntry({ level: 'error' }), { ansi: false });
    expect(text).not.toMatch(/\[/);
  });

  it('includes ANSI when ansi=true', () => {
    const { text } = formatEntry(baseEntry({ level: 'error' }), { ansi: true });
    expect(text).toMatch(/\[31m/);
    expect(text).toMatch(/\[0m/);
  });
});

describe('formatter — error extraction', () => {
  it('attaches stack as indented multi-line block', () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at fn (file.ts:1:1)';
    const ext = extractError(err);
    const { text } = formatEntry(
      baseEntry({ level: 'error', msg: 'failure', error: { message: ext.message, stack: ext.stack } }),
    );
    expect(text).toMatch(/\n  Error: boom\n {4}at fn/);
  });

  it('falls back to message-only line when no stack', () => {
    const { text } = formatEntry(baseEntry({ level: 'error', error: { message: 'no stack' } }));
    expect(text).toMatch(/\n  Error: no stack$/);
  });

  it('redacts secrets in error stack and message lines', () => {
    const { text: stackText } = formatEntry(
      baseEntry({
        level: 'error',
        error: {
          message: 'failed',
          stack:
            'Error: request failed token=abc123\nAuthorization: Bearer secret-token\ncookie: sid=secret-cookie',
        },
      }),
    );
    expect(stackText).toContain('token=[REDACTED]');
    expect(stackText).toContain('Authorization: Bearer [REDACTED]');
    expect(stackText).toContain('cookie: [REDACTED]');
    expect(stackText).not.toContain('abc123');
    expect(stackText).not.toContain('secret-token');
    expect(stackText).not.toContain('secret-cookie');

    const { text: messageText } = formatEntry(
      baseEntry({ level: 'error', error: { message: 'failed access_token=abc123' } }),
    );
    expect(messageText).toContain('access_token=[REDACTED]');
    expect(messageText).not.toContain('abc123');
  });

  it('clips stack to STACK_MAX_BYTES with truncation marker', () => {
    const longStack = 'Error: x\n' + '    at frame()\n'.repeat(1000);
    const { text } = formatEntry(baseEntry({ error: { message: 'x', stack: longStack } }));
    expect(text).toContain('…truncated');
    expect(Buffer.byteLength(text, 'utf-8')).toBeLessThan(STACK_MAX_BYTES + 4096);
  });
});

describe('formatter — limits', () => {
  it('truncates msg over MSG_MAX_CHARS with ellipsis', () => {
    const longMsg = 'x'.repeat(MSG_MAX_CHARS + 50);
    const { text } = formatEntry(baseEntry({ msg: longMsg }));
    expect(text).toContain('…');
  });

  it('truncates a single ctx value over CTX_VALUE_MAX_CHARS', () => {
    const big = 'y'.repeat(CTX_VALUE_MAX_CHARS + 50);
    const { text } = formatEntry(baseEntry({ ctx: { huge: big } }));
    expect(text).toMatch(/huge="?y{300,}…/);
  });

  it('byte-slices the rendered head when entry exceeds ENTRY_MAX_BYTES', () => {
    const ctx: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) ctx[`k${i}`] = 'v'.repeat(50);
    const { text } = formatEntry(baseEntry({ ctx, msg: 'x'.repeat(MSG_MAX_CHARS) }));
    const head = text.split('\n')[0] ?? '';
    expect(Buffer.byteLength(head, 'utf-8')).toBeLessThanOrEqual(ENTRY_MAX_BYTES);
    expect(text).toContain('…truncated');
  });
});

describe('formatter — auto-redact', () => {
  it('redacts top-level sensitive keys', () => {
    const out = redactCtx({
      token: 'abc',
      apiKey: 'def',
      cookie: 'ghi',
      password: 'jkl',
      user: 'x',
    });
    expect(out['token']).toBe('[REDACTED]');
    expect(out['apiKey']).toBe('[REDACTED]');
    expect(out['cookie']).toBe('[REDACTED]');
    expect(out['password']).toBe('[REDACTED]');
    expect(out['user']).toBe('x');
  });

  it('redacts case- and separator-normalized keys', () => {
    const out = redactCtx({
      API_KEY: '1',
      access_token: '2',
      'Refresh-Token': '3',
      Authorization: '4',
      client_secret: '5',
      api_secret: '6',
    });
    expect(out['API_KEY']).toBe('[REDACTED]');
    expect(out['access_token']).toBe('[REDACTED]');
    expect(out['Refresh-Token']).toBe('[REDACTED]');
    expect(out['Authorization']).toBe('[REDACTED]');
    expect(out['client_secret']).toBe('[REDACTED]');
    expect(out['api_secret']).toBe('[REDACTED]');
  });

  it('redacts common secret assignments inside raw string values', () => {
    const { text } = formatEntry(
      baseEntry({
        ctx: {
          stderrTail: 'Authorization: Bearer abc123\napi_key=def456\ncookie: session=ghi789',
        },
      }),
    );
    expect(text).toContain('Authorization: Bearer [REDACTED]');
    expect(text).toContain('api_key=[REDACTED]');
    expect(text).toContain('cookie: [REDACTED]');
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('def456');
    expect(text).not.toContain('ghi789');
  });

  it('recurses into nested objects', () => {
    const out = redactCtx({ headers: { Authorization: 'Bearer xxx', 'X-Trace': '1' } });
    const headers = out['headers'] as Record<string, unknown>;
    expect(headers['Authorization']).toBe('[REDACTED]');
    expect(headers['X-Trace']).toBe('1');
  });

  it('recurses into arrays of objects', () => {
    const out = redactCtx({ tokens: [{ token: 'a' }, { token: 'b' }] });
    const tokens = out['tokens'] as Array<Record<string, unknown>>;
    expect(tokens[0]?.['token']).toBe('[REDACTED]');
    expect(tokens[1]?.['token']).toBe('[REDACTED]');
  });

  it('collapses cycles to [REDACTED:cycle]', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a['self'] = a;
    const out = redactCtx({ a });
    const wrap = out['a'] as Record<string, unknown>;
    expect(wrap['self']).toBe('[REDACTED:cycle]');
  });

  it('collapses deep nesting to [REDACTED:depth]', () => {
    let leaf: Record<string, unknown> = { n: 'leaf' };
    for (let i = 0; i < 20; i++) leaf = { down: leaf };
    const out = redactCtx({ chain: leaf });
    const json = JSON.stringify(out);
    expect(json).toContain('[REDACTED:depth]');
  });
});

describe('extractError', () => {
  it('captures message and stack', () => {
    const e = new Error('boom');
    const result = extractError(e);
    expect(result.message).toBe('boom');
    expect(result.stack).toMatch(/Error: boom/);
  });
});
