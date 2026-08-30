import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'pathe';

import { registerTaskExecutionReviver } from '#/actor/task/revive';
import type {
  AgentTaskInfo,
  AgentTaskInfoBase,
  AgentTaskSink,
  NohupTaskRecovery,
  TaskExecution,
} from '#/actor/task/types';

import type { ProcessTaskInfo } from './process-task';

const REATTACH_POLL_INTERVAL_MS = 1_000;

export interface NohupSpawnInput {
  readonly shellPath: string;
  readonly command: string;
  readonly env: Record<string, string>;
  readonly outputPath: string;
}

export interface NohupSpawnResult {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly pgid: number;
  readonly startEvidence: string;
}

export async function spawnNohupProcess(input: NohupSpawnInput): Promise<NohupSpawnResult> {
  mkdirSync(dirname(input.outputPath), { recursive: true });
  const outFd = openSync(input.outputPath, 'a', 0o600);
  const env = { ...process.env, ...input.env };
  let child: ChildProcess;
  try {
    child = await spawnChecked('nohup', [input.shellPath, '-c', input.command], env, outFd);
  } catch (error) {
    if (!isEnoent(error)) {
      closeSync(outFd);
      throw error;
    }
    child = await spawnChecked(input.shellPath, ['-c', input.command], env, outFd).catch(
      (fallbackError: unknown) => {
        closeSync(outFd);
        throw fallbackError;
      },
    );
  }
  closeSync(outFd);
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error('nohup spawn did not yield a pid');
  const startEvidence = await readStartEvidence(pid);
  return { child, pid, pgid: pid, startEvidence };
}

function spawnChecked(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  outFd: number,
): Promise<ChildProcess> {
  const child = spawn(file, [...args], {
    detached: true,
    env,
    stdio: ['ignore', outFd, outFd],
  });
  return new Promise<ChildProcess>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    child.once('error', onError);
    child.once('spawn', () => {
      child.removeListener('error', onError);
      resolve(child);
    });
  });
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

export function killProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
  }
}

async function readProcessColumn(pid: number, column: string): Promise<string> {
  const child = spawn('ps', ['-o', `${column}=`, '-p', String(pid)]);
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    out += chunk;
  });
  const code = await new Promise<number | null>((resolve) => {
    child.once('error', () => {
      resolve(null);
    });
    child.once('exit', (exitCode) => {
      resolve(exitCode);
    });
  });
  if (code !== 0) throw new Error(`ps -o ${column}= exited with code ${String(code)}`);
  return out.trim();
}

export async function readStartEvidence(pid: number): Promise<string> {
  return readProcessColumn(pid, 'lstart');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function probeNohupProcess(recovery: NohupTaskRecovery): Promise<boolean> {
  try {
    if (!pidAlive(recovery.pid)) return false;
    const stat = await readProcessColumn(recovery.pid, 'stat');
    if (stat.startsWith('Z')) return false;
    const pgidText = await readProcessColumn(recovery.pid, 'pgid');
    if (Number(pgidText) !== recovery.pgid) return false;
    const evidence = await readStartEvidence(recovery.pid);
    if (evidence !== recovery.startEvidence) return false;
    return true;
  } catch {
    return false;
  }
}

function waitChildExit(child: ChildProcess): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      resolve(code);
    });
    child.once('error', () => {
      resolve(null);
    });
  });
}

export class NohupTask implements TaskExecution {
  readonly kind = 'process' as const;
  readonly idPrefix = 'bash';
  private exitCode: number | null = null;

  constructor(
    private readonly child: ChildProcess,
    readonly command: string,
    readonly description: string,
    private readonly recovery: NohupTaskRecovery,
    private release?: () => void,
  ) {}

  async start(sink: AgentTaskSink): Promise<void> {
    const requestStop = (): void => {
      killProcessGroup(this.recovery.pgid, 'SIGTERM');
    };
    if (sink.signal.aborted) {
      requestStop();
    } else {
      sink.signal.addEventListener('abort', requestStop, { once: true });
    }
    try {
      const code = await waitChildExit(this.child);
      this.exitCode = code;
      await sink.settle({
        status: sink.signal.aborted ? 'killed' : code === 0 ? 'completed' : 'failed',
      });
    } finally {
      sink.signal.removeEventListener('abort', requestStop);
    }
  }

  async forceStop(): Promise<void> {
    killProcessGroup(this.recovery.pgid, 'SIGKILL');
  }

  survivesSessionClose(): boolean {
    return true;
  }

  releaseOnSessionClose(): void {
    this.child.unref();
    this.child.removeAllListeners();
    this.release?.();
    this.release = undefined;
  }

  toInfo(base: AgentTaskInfoBase): ProcessTaskInfo {
    return {
      ...base,
      kind: 'process',
      command: this.command,
      pid: this.recovery.pid,
      exitCode: this.exitCode,
      nohup: this.recovery,
    };
  }
}

class ReattachedNohupTask implements TaskExecution {
  readonly kind = 'process' as const;
  readonly idPrefix = 'bash';
  private readonly exitCode: number | null = null;
  private readonly releaseController = new AbortController();

  constructor(
    private readonly command: string,
    readonly description: string,
    private readonly recovery: NohupTaskRecovery,
  ) {}

  async start(sink: AgentTaskSink): Promise<void> {
    const requestStop = (): void => {
      killProcessGroup(this.recovery.pgid, 'SIGTERM');
    };
    if (sink.signal.aborted) {
      requestStop();
    } else {
      sink.signal.addEventListener('abort', requestStop, { once: true });
    }
    try {
      for (;;) {
        if (this.releaseController.signal.aborted) return;
        if (!pidAlive(this.recovery.pid)) break;
        const stat = await readProcessColumn(this.recovery.pid, 'stat').catch(() => '');
        if (stat.startsWith('Z')) break;
        await delay(REATTACH_POLL_INTERVAL_MS, sink.signal, this.releaseController.signal);
      }
      await sink.settle({ status: sink.signal.aborted ? 'killed' : 'completed' });
    } finally {
      sink.signal.removeEventListener('abort', requestStop);
    }
  }

  async forceStop(): Promise<void> {
    killProcessGroup(this.recovery.pgid, 'SIGKILL');
  }

  survivesSessionClose(): boolean {
    return true;
  }

  releaseOnSessionClose(): void {
    this.releaseController.abort();
  }

  toInfo(base: AgentTaskInfoBase): ProcessTaskInfo {
    return {
      ...base,
      kind: 'process',
      command: this.command,
      pid: this.recovery.pid,
      exitCode: this.exitCode,
      nohup: this.recovery,
    };
  }
}

function delay(ms: number, ...signals: readonly AbortSignal[]): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      for (const signal of signals) signal.removeEventListener('abort', onAbort);
    };
    if (signals.some((signal) => signal.aborted)) {
      cleanup();
      resolve();
      return;
    }
    for (const signal of signals) signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function reviveProcessTask(info: AgentTaskInfo): Promise<TaskExecution | undefined> {
  if (info.kind !== 'process') return undefined;
  const recovery = info.nohup;
  if (recovery === undefined) return undefined;
  if (!(await probeNohupProcess(recovery))) return undefined;
  return new ReattachedNohupTask(info.command, info.description, recovery);
}

registerTaskExecutionReviver('process', reviveProcessTask);
