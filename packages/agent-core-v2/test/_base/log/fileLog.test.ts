import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileLogWriter, PENDING_MAX, RotatingFileWriter } from '#/_base/log/fileLog';
import type { LogEntry } from '#/_base/log/log';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'logger-sinks-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function listLogs(dir: string): Promise<string[]> {
  return (await readdir(dir)).toSorted();
}

describe('RotatingFileWriter', () => {
  it('writes single line to active file', async () => {
    const sink = new RotatingFileWriter({
      path: join(workDir, 'app.log'),
      maxBytes: 1024,
      files: 3,
    });
    sink.enqueue('hello\n');
    await sink.flush();
    const text = await readFile(join(workDir, 'app.log'), 'utf-8');
    expect(text).toBe('hello\n');
  });

  it('rotates when active file exceeds maxBytes', async () => {
    const path = join(workDir, 'app.log');
    const sink = new RotatingFileWriter({ path, maxBytes: 64, files: 3 });
    for (let i = 0; i < 20; i++) {
      sink.enqueue(`line${i} ${'x'.repeat(20)}\n`);
      await sink.flush();
    }
    const files = await listLogs(workDir);
    expect(files).toContain('app.log');
    expect(files).toContain('app.log.1');
  });

  it('evicts oldest archive after files=N rolls', async () => {
    const path = join(workDir, 'app.log');
    const sink = new RotatingFileWriter({ path, maxBytes: 32, files: 2 });
    for (let i = 0; i < 50; i++) {
      sink.enqueue(`${i.toString().padStart(3, '0')} ${'x'.repeat(30)}\n`);
      await sink.flush();
    }
    sink.enqueue('final\n');
    await sink.flush();
    const files = await listLogs(workDir);
    expect(files).toEqual(expect.arrayContaining(['app.log']));
    expect(files.some((f) => /^app\.log\.[2-9]$/.test(f))).toBe(false);
  });

  it('rotates a large pending batch instead of writing it as one oversized file', async () => {
    const path = join(workDir, 'app.log');
    const maxBytes = 128;
    const sink = new RotatingFileWriter({ path, maxBytes, files: 3 });
    for (let i = 0; i < 24; i++) {
      sink.enqueue(`line${i.toString().padStart(2, '0')} ${'x'.repeat(24)}\n`);
    }

    await sink.flush();

    const files = await listLogs(workDir);
    expect(files).toContain('app.log.1');
    for (const file of files) {
      expect((await stat(join(workDir, file))).size).toBeLessThanOrEqual(maxBytes);
    }
  });

  it('drops oldest when pending overflows', async () => {
    const path = join(workDir, 'app.log');
    const sink = new RotatingFileWriter({ path, maxBytes: 1_000_000, files: 2 });
    const over = PENDING_MAX + 500;
    for (let i = 0; i < over; i++) {
      sink.enqueue(`line${i}\n`);
    }
    await sink.flush();
    const text = await readFile(path, 'utf-8');
    expect(text).toMatch(/\.\.\. dropped \d+ entries \.\.\./);
    expect(text).not.toContain('line0\n');
    expect(text).toContain(`line${over - 1}\n`);
  });

  it('does not throw when fs write fails; emits stderr notice', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const badWriter = new RotatingFileWriter({
      path: '\0/invalid/path',
      maxBytes: 1024,
      files: 2,
    });
    badWriter.enqueue('x\n');
    expect(await badWriter.flush()).toBe(false);
    expect(
      stderrSpy.mock.calls.some((c) => String(c[0]).includes('[logger] write failed')),
    ).toBe(true);
    stderrSpy.mockRestore();
  });

  it('keeps restored pending bounded after repeated write failures', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const badWriter = new RotatingFileWriter({
      path: '\0/invalid/path',
      maxBytes: 1024,
      files: 2,
    });
    try {
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < PENDING_MAX + 25; i++) {
          badWriter.enqueue(`round${round}-line${i}\n`);
        }
        expect(await badWriter.flush()).toBe(false);
      }
      const pending = (badWriter as unknown as { pending: readonly string[] }).pending;
      expect(pending.length).toBeLessThanOrEqual(PENDING_MAX);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('returns true when flush writes successfully', async () => {
    const path = join(workDir, 'app.log');
    const sink = new RotatingFileWriter({ path, maxBytes: 1024, files: 2 });
    sink.enqueue('ok\n');
    expect(await sink.flush()).toBe(true);
  });

  it('serializes concurrent writes without interleaving lines', async () => {
    const path = join(workDir, 'app.log');
    const sink = new RotatingFileWriter({ path, maxBytes: 10_000_000, files: 2 });
    const N = 500;
    for (let i = 0; i < N; i++) {
      sink.enqueue(`line${i.toString().padStart(4, '0')}\n`);
    }
    await sink.flush();
    const text = await readFile(path, 'utf-8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(N);
    for (const line of lines) {
      expect(line).toMatch(/^line\d{4}$/);
    }
  });
});

describe('FileLogWriter (ILogWriter)', () => {
  function entry(overrides: Partial<LogEntry> = {}): LogEntry {
    return {
      t: Date.UTC(2026, 4, 19, 10, 12, 30, 123),
      level: 'info',
      msg: 'hello',
      ...overrides,
    };
  }

  it('formats entries as logfmt lines', async () => {
    const path = join(workDir, 'app.log');
    const sink = new FileLogWriter({ path, maxBytes: 1_000_000, files: 2 });
    sink.write(entry({ ctx: { requestId: 'r1' } }));
    await sink.flush();
    const text = await readFile(path, 'utf-8');
    expect(text).toContain('INFO  hello');
    expect(text).toContain('requestId=r1');
    await sink.close();
  });

  it('redacts secret ctx values before writing', async () => {
    const path = join(workDir, 'app.log');
    const sink = new FileLogWriter({ path, maxBytes: 1_000_000, files: 2 });
    sink.write(entry({ ctx: { token: 'super-secret' } }));
    await sink.flush();
    const text = await readFile(path, 'utf-8');
    expect(text).toContain('token=[REDACTED]');
    expect(text).not.toContain('super-secret');
    await sink.close();
  });

  it('omits configured context keys', async () => {
    const path = join(workDir, 'app.log');
    const sink = new FileLogWriter({
      path,
      maxBytes: 1_000_000,
      files: 2,
      format: { omitContextKeys: ['sessionId'] },
    });
    sink.write(entry({ ctx: { sessionId: 's1', requestId: 'r1' } }));
    await sink.flush();
    const text = await readFile(path, 'utf-8');
    expect(text).not.toContain('sessionId');
    expect(text).toContain('requestId=r1');
    await sink.close();
  });
});
