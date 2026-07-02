/**
 * `process` domain (L1) — spawned-process primitives.
 *
 * Vendored from the former `@moonshot-ai/kaos` `LocalProcess`. `SpawnedProcess`
 * wraps a Node `ChildProcess` into the domain-facing `IProcess` handle, and
 * `buildLocalSpawnOptions` / `waitForSpawn` are the two spawn-time helpers used
 * by the session process runner. Kept out of the runner file so the runner
 * only orchestrates cwd/env resolution and delegates the lifetime plumbing
 * here.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import { BufferedReadable } from '#/_base/execEnv';

import type { IProcess } from './process';

export const isWindows: boolean = process.platform === 'win32';

export function buildLocalSpawnOptions(
  isWindowsHost: boolean,
  cwd: string,
  env: Record<string, string> | undefined,
): SpawnOptions {
  return {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: !isWindowsHost,
    windowsHide: true,
  };
}

// Wait for a freshly spawned ChildProcess to either emit 'spawn' (success) or
// 'error' (ENOENT / EACCES / etc.). Until this resolves, callers should not
// assume the child is running — they may otherwise write to the stdin of a
// process that never existed.
export function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      child.off('error', onError);
      resolve();
    };
    const onError = (err: Error): void => {
      child.off('spawn', onSpawn);
      reject(err);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

export class SpawnedProcess implements IProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: number;

  private readonly _child: ChildProcess;
  private _exitCode: number | null = null;
  private readonly _exitPromise: Promise<number>;
  private _disposed = false;

  constructor(child: ChildProcess) {
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      throw new Error('Process must be created with stdin/stdout/stderr pipes.');
    }

    this._child = child;
    this.stdin = child.stdin;
    this.stdout = new BufferedReadable(child.stdout);
    this.stderr = new BufferedReadable(child.stderr);
    this.pid = child.pid ?? -1;

    this._exitPromise = new Promise<number>((resolve, reject) => {
      child.on('exit', (code: number | null) => {
        this._exitCode = code ?? -1;
        resolve(this._exitCode);
      });
      child.on('error', (error: Error) => {
        reject(error);
      });
    });
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  async wait(): Promise<number> {
    return this._exitPromise;
  }

  kill(signal?: NodeJS.Signals): Promise<void> {
    // Reject if the process never actually started (spawn failed).
    // pid <= 0 indicates ChildProcess.pid was undefined, which happens
    // when spawn() fails to find/execute the command. Calling
    // process.kill(-1, ...) on POSIX would signal the entire process
    // group, potentially killing unrelated processes.
    if (this.pid <= 0) {
      return Promise.resolve();
    }

    // On Windows, `ChildProcess.kill()` only signals the shell parent, leaving
    // grandchildren alive, so terminate the whole process tree with
    // `taskkill /T`. A graceful `taskkill /T` (no `/F`) does not actually
    // terminate a console node.exe tree, and Windows has no real graceful
    // signal for it — Node's own `ChildProcess.kill()` is always a forceful
    // TerminateProcess on Windows — so always force-terminate the tree.
    if (isWindows) {
      const taskkillArgs = ['/T', '/F', '/PID', String(this.pid)];
      return new Promise<void>((resolve) => {
        const killer = spawn('taskkill', taskkillArgs, {
          stdio: 'ignore',
          windowsHide: true,
        });
        const done = (): void => {
          resolve();
        };
        killer.once('error', done);
        killer.once('close', done);
      });
    }

    // On POSIX, `detached:true` makes the child a process-group leader
    // (pgid === pid). A plain `ChildProcess.kill()` still only signals the
    // direct child, so a shell like `bash -c 'sleep 100 & sleep 100'` leaves
    // grandchildren orphaned. `process.kill(-pid, signal)` signals the group
    // (negative pid = process-group id under POSIX kill(2)).
    try {
      process.kill(-this.pid, signal ?? 'SIGTERM');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      // ESRCH = group already gone (child exited + reaped between
      // `wait()` racing spawn + this call). Treat as successful kill.
      if (err.code === 'ESRCH') return Promise.resolve();
      // EPERM is typically a misconfiguration (e.g. non-detached
      // spawn earlier in the file); fall back to direct `.kill()` so
      // we at least signal the direct child instead of throwing.
      if (err.code === 'EPERM') {
        try {
          this._child.kill(signal ?? 'SIGTERM');
        } catch {
          /* best effort */
        }
        return Promise.resolve();
      }
      throw error;
    }
    return Promise.resolve();
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.stdin.destroy();
    this.stdout.destroy();
    this.stderr.destroy();
  }
}
