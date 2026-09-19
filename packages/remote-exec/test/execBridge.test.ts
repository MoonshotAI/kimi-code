import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { ExecBridge } from '../src/client/execBridge';

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

    // stdout is deliberately left open: the exit alone must surface closed.
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

    // An 'error' emission with no listener would throw uncaught; the bridge
    // installs the guard at construction.
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
    // Without the stdin 'error' guard, writing into the dead child's pipe
    // raises EPIPE uncaught and fails the whole test run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    bridge.write(new Uint8Array([1, 2, 3]));
    bridge.end();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onEnd).toHaveBeenCalled();
  });
});
