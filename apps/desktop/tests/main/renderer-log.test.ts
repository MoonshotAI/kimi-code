import { describe, it, expect, vi } from 'vitest';

import {
  asRendererLogPayload,
  createRendererLogWriter,
  sanitizeRendererLogMessage,
  serializeRendererLogDetail,
} from '../../src/main/renderer-log';

// renderer-log.ts pulls in log.ts, which imports electron for the crash
// dialog; mock it (same pattern as log.test.ts).
vi.mock('electron', () => ({ dialog: { showErrorBox: vi.fn() } }));

describe('asRendererLogPayload', () => {
  it('accepts a well-formed payload', () => {
    expect(asRendererLogPayload({ level: 'warn', message: 'm', detail: { a: 1 } })).toEqual({
      level: 'warn',
      message: 'm',
      detail: { a: 1 },
    });
  });

  it('drops payloads without a whitelisted level or a non-empty string message', () => {
    expect(asRendererLogPayload(null)).toBeNull();
    expect(asRendererLogPayload('warn')).toBeNull();
    expect(asRendererLogPayload({ level: 'debug', message: 'm' })).toBeNull();
    expect(asRendererLogPayload({ level: 'info' })).toBeNull();
    expect(asRendererLogPayload({ level: 'info', message: '' })).toBeNull();
    expect(asRendererLogPayload({ level: 'info', message: 42 })).toBeNull();
  });

  it('omits detail when absent', () => {
    expect(asRendererLogPayload({ level: 'error', message: 'm' })).toEqual({
      level: 'error',
      message: 'm',
    });
  });
});

describe('sanitizeRendererLogMessage', () => {
  it('redacts credentials embedded in URLs and auth headers', () => {
    expect(sanitizeRendererLogMessage('failed http://h/api?token=abc123&x=1')).toBe(
      'failed http://h/api?token=[redacted]&x=1',
    );
    expect(sanitizeRendererLogMessage('failed http://h/#token=abc123')).toBe(
      'failed http://h/#token=[redacted]',
    );
    expect(sanitizeRendererLogMessage('Authorization: Bearer sk-live-secret')).toBe(
      'Authorization: Bearer [redacted]',
    );
  });

  it('truncates oversized messages', () => {
    const long = 'x'.repeat(3_000);
    const out = sanitizeRendererLogMessage(long);
    expect(out.startsWith('x'.repeat(2_000))).toBe(true);
    expect(out).toContain('[+1000 chars]');
  });
});

describe('serializeRendererLogDetail', () => {
  it('is undefined without detail', () => {
    expect(serializeRendererLogDetail(undefined)).toBeUndefined();
  });

  it('redacts sensitive keys at any depth', () => {
    const json = serializeRendererLogDetail({ auth: { accessToken: 't', ok: 1 }, api_key: 'k' });
    expect(json).toBe('{"auth":{"accessToken":"[redacted]","ok":1},"api_key":"[redacted]"}');
    const pii = serializeRendererLogDetail({
      email: 'u@example.com',
      phone: { countryCode: '86', number: '176****0000' },
      nickname: 'n',
      avatar: 'https://example.com/a.png',
    });
    expect(pii).toBe(
      '{"email":"[redacted]","phone":"[redacted]","nickname":"[redacted]","avatar":"[redacted]"}',
    );
  });

  it('folds base64-ish runs and truncates long strings', () => {
    expect(serializeRendererLogDetail('A'.repeat(300))).toBe('"[base64-like, 300 chars omitted]"');
    const json = serializeRendererLogDetail(`chunk ${'y'.repeat(3_000)}`);
    expect(json).toContain('[+');
    expect(json!.length).toBeLessThan(2_100);
  });

  it('caps the serialized size', () => {
    const json = serializeRendererLogDetail(['a '.repeat(1_200), 'b '.repeat(1_200), 'c '.repeat(1_200)]);
    expect(json!.length).toBeLessThan(4_200);
    expect(json).toContain('[truncated]');
  });

  it('survives hostile input (throwing getter) with a placeholder', () => {
    const hostile = {
      get boom(): unknown {
        throw new Error('nope');
      },
    };
    expect(serializeRendererLogDetail(hostile)).toBe('[unserializable detail]');
  });
});

describe('createRendererLogWriter', () => {
  function collect() {
    const lines: Array<{ level: string; line: string }> = [];
    return {
      lines,
      write: (level: 'info' | 'warn' | 'error', line: string) => lines.push({ level, line }),
    };
  }

  it('prefixes lines with [renderer], routes the level, appends detail JSON', () => {
    const { lines, write } = collect();
    const writer = createRendererLogWriter(write);
    writer({ level: 'warn', message: 'careful', detail: { code: 1 } });
    writer({ level: 'error', message: 'boom' });
    expect(lines).toEqual([
      { level: 'warn', line: '[renderer] careful  {"code":1}' },
      { level: 'error', line: '[renderer] boom' },
    ]);
  });

  it('drops malformed payloads silently', () => {
    const { lines, write } = collect();
    const writer = createRendererLogWriter(write);
    writer({ level: 'debug', message: 'x' });
    writer(undefined);
    expect(lines).toEqual([]);
  });

  it('caps a sliding window at 120 lines and reports the drop count afterwards', () => {
    const { lines, write } = collect();
    let now = 1_000_000;
    const writer = createRendererLogWriter(write, () => now);
    for (let i = 0; i < 150; i++) {
      writer({ level: 'info', message: `line ${i}` });
    }
    expect(lines).toHaveLength(120);

    now += 61_000;
    writer({ level: 'info', message: 'after window' });
    expect(lines).toHaveLength(122);
    expect(lines[120]!.line).toBe('[renderer] dropped 30 log line(s) in the last minute (rate limit)');
    expect(lines[121]!.line).toBe('[renderer] after window');
  });

  it('flushes the drop summary on a timer when no further payload arrives', () => {
    vi.useFakeTimers();
    try {
      const { lines, write } = collect();
      const writer = createRendererLogWriter(write, () => Date.now());
      for (let i = 0; i < 130; i++) {
        writer({ level: 'info', message: `line ${i}` });
      }
      expect(lines).toHaveLength(120);

      vi.advanceTimersByTime(61_000);
      expect(lines).toHaveLength(121);
      expect(lines[120]!.line).toBe('[renderer] dropped 10 log line(s) in the last minute (rate limit)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reschedules the drop-summary timer when the window rolls before it fires', () => {
    vi.useFakeTimers();
    try {
      const { lines, write } = collect();
      const writer = createRendererLogWriter(write, () => Date.now());
      for (let i = 0; i < 130; i++) {
        writer({ level: 'info', message: `storm1 ${i}` });
      }
      expect(lines).toHaveLength(120);

      // Time jumps past the window boundary (sleep / blocked event loop)
      // while the flush timer is still pending; a payload rolls the window.
      vi.setSystemTime(Date.now() + 61_000);
      writer({ level: 'info', message: 'after sleep' });
      expect(lines.at(-2)!.line).toBe(
        '[renderer] dropped 10 log line(s) in the last minute (rate limit)',
      );
      expect(lines.at(-1)!.line).toBe('[renderer] after sleep');

      for (let i = 0; i < 130; i++) {
        writer({ level: 'info', message: `storm2 ${i}` });
      }
      // The overdue first-window timer fires now; it must not consume the
      // second window's flush — the rescheduled timer reports storm 2's
      // drops (11: the 'after sleep' payload took one of the 120 slots).
      vi.advanceTimersByTime(1);
      vi.advanceTimersByTime(60_000);
      expect(lines.at(-1)!.line).toBe(
        '[renderer] dropped 11 log line(s) in the last minute (rate limit)',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes Error details instead of dropping them as {}', () => {
    const { lines, write } = collect();
    const writer = createRendererLogWriter(write);
    writer({ level: 'error', message: 'operation failed', detail: new Error('kaput') });
    expect(lines[0]!.line).toContain('"name":"Error"');
    expect(lines[0]!.line).toContain('"message":"kaput"');
    expect(lines[0]!.line).toContain('"stack"');
  });

  it('flattens CR/LF so one payload stays one physical log line', () => {
    const { lines, write } = collect();
    const writer = createRendererLogWriter(write);
    writer({ level: 'warn', message: 'first\nsecond\r\nthird' });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.line).toBe('[renderer] first\\nsecond\\r\\nthird');
  });

  it('redacts the full sensitive-name set and auth schemes inline', () => {
    expect(sanitizeRendererLogMessage('client_secret=abc def')).toBe('client_secret=[redacted] def');
    expect(sanitizeRendererLogMessage('Cookie=session=xyz;')).toBe('Cookie=[redacted]');
    expect(sanitizeRendererLogMessage('Authorization: Basic dXNlcg==')).toBe(
      'Authorization: Basic [redacted]',
    );
    // key=value holding a scheme: both halves must go, no token left behind.
    expect(sanitizeRendererLogMessage('authorization=Bearer abc123')).toBe(
      'authorization=[redacted] [redacted]',
    );
  });
});
