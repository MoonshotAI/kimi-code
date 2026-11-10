import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { downloadToFile, runCommand } from '#/app/capability/host';
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

describe('capability host downloadToFile', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'capability-download-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function fakeFetchWith(body: ReadableStream): typeof fetch {
    return (() =>
      Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { 'content-length': '100' },
        }),
      )) as unknown as typeof fetch;
  }

  it('aborts a response whose byte stream goes quiet', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
    });

    await expect(
      downloadToFile(
        'https://cdn.example.test/blob',
        path.join(root, 'blob'),
        undefined,
        fakeFetchWith(body) as never,
        { idleTimeoutMs: 5 },
      ),
    ).rejects.toThrow(/stalled/);
  });

  it('aborts when the response headers never arrive', async () => {
    const hangingFetch = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted.', 'AbortError'));
        });
      })) as never;

    await expect(
      downloadToFile(
        'https://cdn.example.test/headers',
        path.join(root, 'headers'),
        undefined,
        hangingFetch,
        { idleTimeoutMs: 5 },
      ),
    ).rejects.toThrow(/no response within 5ms/);
  });

  it('lets a slow but flowing download finish intact', async () => {
    const chunks = ['hel', 'lo ', 'wor', 'ld'];
    const body = new ReadableStream({
      async start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
          await new Promise((resolve) => {
            setTimeout(resolve, 30);
          });
        }
        controller.close();
      },
    });

    const dest = path.join(root, 'hello.txt');
    const received = await downloadToFile(
      'https://cdn.example.test/hello',
      dest,
      undefined,
      fakeFetchWith(body) as never,
      { idleTimeoutMs: 50 },
    );

    expect(received).toBe(11);
    expect(await readFile(dest, 'utf-8')).toBe('hello world');
  });
});
