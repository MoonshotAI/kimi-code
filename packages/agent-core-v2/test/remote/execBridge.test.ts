import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { ExecBridge } from '#/remote/client/execBridge';

type FakeChild = ChildProcess & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as unknown as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

describe('ExecBridge disconnect guards', () => {
  it('treats the child exit as a disconnect signal and drops later writes', () => {
    const child = fakeChild();
    const bridge = ExecBridge.adopt(child);
    const onEnd = vi.fn();
    bridge.onEnd(onEnd);
    const stdinWrite = vi.spyOn(child.stdin, 'write');
    const stdinEnd = vi.spyOn(child.stdin, 'end');

    child.emit('exit', 0, null);

    expect(onEnd).toHaveBeenCalledTimes(1);
    bridge.write(new Uint8Array([1]));
    bridge.end();
    expect(stdinWrite).not.toHaveBeenCalled();
    expect(stdinEnd).not.toHaveBeenCalled();
  });

  it('swallows a stdin error, surfaces closed, and drops later writes', () => {
    const child = fakeChild();
    const bridge = ExecBridge.adopt(child);
    const onEnd = vi.fn();
    bridge.onEnd(onEnd);
    const stdinWrite = vi.spyOn(child.stdin, 'write');

    child.stdin.emit('error', new Error('write EPIPE'));

    expect(onEnd).toHaveBeenCalledTimes(1);
    bridge.write(new Uint8Array([1]));
    bridge.end();
    expect(stdinWrite).not.toHaveBeenCalled();
  });

  it('survives writes after the spawned child exits — no uncaught EPIPE', async () => {
    const bridge = ExecBridge.spawn({
      program: process.execPath,
      args: ['-e', 'process.exit(0)'],
    });
    const onEnd = vi.fn();
    bridge.onEnd(onEnd);
    await bridge.exited;

    await new Promise((resolve) => setTimeout(resolve, 20));
    bridge.write(new Uint8Array([1, 2, 3]));
    bridge.end();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onEnd).toHaveBeenCalled();
  });
});

describe('ExecBridge spawn environment', () => {
  async function captureStdout(bridge: ExecBridge): Promise<string> {
    let out = '';
    bridge.onData((chunk) => {
      out += Buffer.from(chunk).toString('utf8');
    });
    await Promise.all([bridge.exited, new Promise<void>((resolve) => bridge.onEnd(resolve))]);
    return out;
  }

  it('uses options.env verbatim instead of merging the host environment', async () => {
    vi.stubEnv('REMOTE_EXEC_TEST_HOST_ONLY', 'host-secret');
    try {
      const bridge = ExecBridge.spawn({
        program: process.execPath,
        args: ['-e', 'process.stdout.write(process.env["REMOTE_EXEC_TEST_HOST_ONLY"] ?? "<absent>")'],
        env: { PATH: process.env['PATH'] ?? '' },
      });
      expect(await captureStdout(bridge)).toBe('<absent>');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('inherits the host environment when env is undefined', async () => {
    vi.stubEnv('REMOTE_EXEC_TEST_HOST_ONLY', 'host-secret');
    try {
      const bridge = ExecBridge.spawn({
        program: process.execPath,
        args: ['-e', 'process.stdout.write(process.env["REMOTE_EXEC_TEST_HOST_ONLY"] ?? "<absent>")'],
      });
      expect(await captureStdout(bridge)).toBe('host-secret');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
