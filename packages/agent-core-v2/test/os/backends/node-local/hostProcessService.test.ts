import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Readable, Writable, PassThrough } from 'node:stream';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import {
  HostProcessError,
  HostProcessErrorCode,
  IHostProcessService,
} from '#/os/interface/hostProcess';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('HostProcessService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IHostProcessService, HostProcessService);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('spawns a process and captures stdout + exit code', async () => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('node', ['-e', 'process.stdout.write("ok")']);
    const out = await collect(proc.stdout);
    expect(out).toBe('ok');
    expect(await proc.wait()).toBe(0);
    expect(proc.exitCode).toBe(0);
  });

  it('passes env overrides to the child', async () => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('node', ['-e', 'process.stdout.write(process.env.FOO ?? "")'], {
      env: { FOO: 'bar' },
    });
    const out = await collect(proc.stdout);
    expect(out).toBe('bar');
    expect(await proc.wait()).toBe(0);
  });

  it('throws a coded error when the command does not exist', async () => {
    const svc = ix.get(IHostProcessService);
    await expect(svc.spawn('definitely-not-a-real-command-42')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(HostProcessError);
      const error = err as HostProcessError;
      expect(error.code).toBe(HostProcessErrorCode.SpawnFailed);
      expect(error.code).toBe('os.process.spawn_failed');
      expect(error.details).toMatchObject({
        command: 'definitely-not-a-real-command-42',
        errno: 'ENOENT',
      });
      expect(error.cause).toBeInstanceOf(Error);
      return true;
    });
  });

  it('terminates a running process with kill()', async () => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('node', ['-e', 'setTimeout(() => {}, 30000)']);
    expect(proc.pid).toBeGreaterThan(0);
    await proc.kill('SIGTERM');
    const code = await proc.wait();
    expect(code).not.toBe(0);
  });

  it('captures stderr output separately from stdout', async () => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('node', ['-e', 'process.stderr.write("err msg")']);
    const out = await collect(proc.stdout);
    const err = await collect(proc.stderr);
    expect(out).toBe('');
    expect(err).toBe('err msg');
    expect(await proc.wait()).toBe(0);
  });

  it('returns a non-zero exit code when the child process fails', async () => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('node', ['-e', 'process.exit(42)']);
    const code = await proc.wait();
    expect(code).toBe(42);
    expect(proc.exitCode).toBe(42);
  });

  it('inherits the parent environment when no env overrides are given', async () => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('node', ['-e', 'process.stdout.write(process.env.PATH ?? "")']);
    const out = await collect(proc.stdout);
    expect(out.length).toBeGreaterThan(0);
    expect(await proc.wait()).toBe(0);
  });

  it('spawns a process with a shell pipe and captures combined output', async () => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('node', ['-e', 'process.stdout.write("line1\\nline2\\nline3")']);
    const out = await collect(proc.stdout);
    const lines = out.split('\n').filter(Boolean);
    expect(lines).toEqual(['line1', 'line2', 'line3']);
    expect(await proc.wait()).toBe(0);
  });

  it('accepts and writes to stdin', async () => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('node', [
      '-e',
      'process.stdin.on("data", (d) => process.stdout.write(d.toString().toUpperCase())); process.stdin.on("end", () => process.stdout.write("DONE"))',
    ]);
    proc.stdin.write('hello');
    proc.stdin.end();
    const out = await collect(proc.stdout);
    expect(out).toBe('helloDONE');
    expect(await proc.wait()).toBe(0);
  });

  it('handles a large stdout buffer without truncation', async () => {
    const svc = ix.get(IHostProcessService);
    const size = 100_000;
    const proc = await svc.spawn('node', ['-e', `process.stdout.write("${'x'.repeat(size)}")`]);
    const out = await collect(proc.stdout);
    expect(out.length).toBe(size);
    expect(await proc.wait()).toBe(0);
  });

  it('spawns multiple concurrent processes without interference', async () => {
    const svc = ix.get(IHostProcessService);
    const p1 = svc.spawn('node', ['-e', 'process.stdout.write("first")']);
    const p2 = svc.spawn('node', ['-e', 'process.stdout.write("second")']);
    const [proc1, proc2] = await Promise.all([p1, p2]);
    const [out1, out2] = await Promise.all([collect(proc1.stdout), collect(proc2.stdout)]);
    expect(out1).toBe('first');
    expect(out2).toBe('second');
    expect(await proc1.wait()).toBe(0);
    expect(await proc2.wait()).toBe(0);
  });

  it('disposes a process without throwing after it has exited', async () => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('node', ['-e', 'process.exit(0)']);
    await proc.wait();
    await expect(proc.dispose()).resolves.toBeUndefined();
  });
});
