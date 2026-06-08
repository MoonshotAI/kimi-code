import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PENDING_MAX, RotatingFileSink } from '#/logging/sinks';

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

describe('RotatingFileSink', () => {
  it('writes single line to active file', async () => {
    const sink = new RotatingFileSink({
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
    const sink = new RotatingFileSink({ path, maxBytes: 64, files: 3 });
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
    const sink = new RotatingFileSink({ path, maxBytes: 32, files: 2 });
    for (let i = 0; i < 50; i++) {
      sink.enqueue(`${i.toString().padStart(3, '0')} ${'x'.repeat(30)}\n`);
      await sink.flush();
    }
    // Final write to ensure active file exists post-rotation
    sink.enqueue('final\n');
    await sink.flush();
    const files = await listLogs(workDir);
    expect(files).toEqual(expect.arrayContaining(['app.log']));
    // files = 2 → active + at most 1 archive; no app.log.2 or higher
    expect(files.some((f) => /^app\.log\.[2-9]$/.test(f))).toBe(false);
  });

  it('rotates a large pending batch instead of writing it as one oversized file', async () => {
    const path = join(workDir, 'app.log');
    const maxBytes = 128;
    const sink = new RotatingFileSink({ path, maxBytes, files: 3 });
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
    const sink = new RotatingFileSink({ path, maxBytes: 1_000_000, files: 2 });
    const over = PENDING_MAX + 500;
    for (let i = 0; i < over; i++) {
      sink.enqueue(`line${i}\n`);
    }
    await sink.flush();
    const text = await readFile(path, 'utf-8');
    expect(text).toMatch(/\.\.\. dropped \d+ entries \.\.\./);
    // First lines (oldest) should be gone
    expect(text).not.toContain('line0\n');
    // Latest should be present
    expect(text).toContain(`line${over - 1}\n`);
  });

  it('does not throw when fs write fails; emits stderr notice', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Force failure by passing an invalid path char on POSIX
    const badSink = new RotatingFileSink({
      path: '\0/invalid/path',
      maxBytes: 1024,
      files: 2,
    });
    badSink.enqueue('x\n');
    expect(await badSink.flush()).toBe(false);
    expect(
      stderrSpy.mock.calls.some((c) => String(c[0]).includes('[logger] write failed')),
    ).toBe(true);
    stderrSpy.mockRestore();
  });

  it('keeps restored pending bounded after repeated write failures', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const badSink = new RotatingFileSink({
      path: '\0/invalid/path',
      maxBytes: 1024,
      files: 2,
    });
    try {
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < PENDING_MAX + 25; i++) {
          badSink.enqueue(`round${round}-line${i}\n`);
        }
        expect(await badSink.flush()).toBe(false);
      }
      const pending = (badSink as unknown as { pending: readonly string[] }).pending;
      expect(pending.length).toBeLessThanOrEqual(PENDING_MAX);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('returns true when flush writes successfully', async () => {
    const path = join(workDir, 'app.log');
    const sink = new RotatingFileSink({ path, maxBytes: 1024, files: 2 });
    sink.enqueue('ok\n');
    expect(await sink.flush()).toBe(true);
  });

  it('serializes concurrent writes without interleaving lines', async () => {
    const path = join(workDir, 'app.log');
    const sink = new RotatingFileSink({ path, maxBytes: 10_000_000, files: 2 });
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
