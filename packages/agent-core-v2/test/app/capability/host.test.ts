/**
 * Capability host helpers — command timeout cleanup and late process-stream
 * failures after a timed-out command.
 */

import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { runCommand } from '#/app/capability/host';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';

describe('capability host runCommand', () => {
  it('does not leak a rejected promise when a timed-out process fails while being killed', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let rejectWait: ((error: Error) => void) | undefined;
    const wait = new Promise<number>((_resolve, reject) => {
      rejectWait = reject;
    });
    const proc = {
      _serviceBrand: undefined,
      pid: 1234,
      exitCode: null,
      stdin: new Writable({
        write: (_chunk, _encoding, callback) => {
          callback();
        },
      }),
      stdout,
      stderr,
      wait: () => wait,
      kill: () => {
        stdout.destroy(new Error('stream closed after timeout'));
        stderr.end();
        rejectWait?.(new Error('process killed'));
        return Promise.resolve();
      },
      dispose: () => undefined,
    } as IHostProcess;
    const host = {
      _serviceBrand: undefined,
      spawn: () => Promise.resolve(proc),
    } as IHostProcessService;
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      await expect(runCommand(host, 'hang', [], { timeout: 5 })).rejects.toThrow(
        'command timed out after 5ms: hang',
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
