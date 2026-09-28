import type { Readable, Writable } from 'node:stream';
import { Worker } from 'node:worker_threads';

import { BufferedReadable } from '#/_base/execEnv/bufferedReadable';
import type { IHostProcess } from '#/os/interface/hostProcess';

class WorkerHookProcess implements IHostProcess {
  declare readonly _serviceBrand: undefined;

  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: number;

  private readonly worker: Worker;
  private readonly exitPromise: Promise<number>;
  private exitCodeValue: number | null = null;

  constructor(worker: Worker) {
    if (worker.stdin === null || worker.stdout === null || worker.stderr === null) {
      throw new Error('worker stdio pipes are unavailable');
    }
    this.worker = worker;
    this.stdin = worker.stdin;
    this.stdout = new BufferedReadable(worker.stdout);
    this.stderr = new BufferedReadable(worker.stderr);
    this.pid = worker.threadId;
    this.exitPromise = new Promise<number>((resolve, reject) => {
      worker.once('exit', (code: number) => {
        this.exitCodeValue = code;
        resolve(code);
      });
      worker.once('error', (error: Error) => {
        reject(error);
      });
    });
  }

  get exitCode(): number | null {
    return this.exitCodeValue;
  }

  async wait(): Promise<number> {
    return this.exitPromise;
  }

  async kill(): Promise<void> {
    await this.worker.terminate();
  }

  dispose(): void {
    this.stdin.destroy();
    this.stdout.destroy();
    this.stderr.destroy();
    if (this.exitCodeValue === null) {
      void this.worker.terminate();
    }
  }
}

export function spawnWorkerHookProcess(
  entry: string,
  env?: Record<string, string>,
): IHostProcess {
  const worker = new Worker(entry, {
    stdin: true,
    stdout: true,
    stderr: true,
    env:
      env === undefined
        ? undefined
        : { ...(process.env as Record<string, string>), ...env },
  });
  return new WorkerHookProcess(worker);
}
