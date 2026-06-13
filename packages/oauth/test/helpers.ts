import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';

const tsxCli = join(
  dirname(createRequire(import.meta.url).resolve('tsx/package.json')),
  'dist',
  'cli.mjs',
);

export interface TempDirHandle {
  readonly path: string;
  cleanup(): Promise<void>;
}

export async function createTempWorkDir(): Promise<TempDirHandle> {
  const path = await mkdtemp(join(tmpdir(), 'kimi-oauth-test-work-'));
  let disposed = false;
  return {
    path,
    cleanup: async () => {
      if (disposed) return;
      disposed = true;
      await rm(path, { recursive: true, force: true });
    },
  };
}

export interface SpawnedWorker {
  readonly id: number;
  readonly pid: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
}

export interface SpawnInlineWorkersOptions {
  readonly count: number;
  readonly inlineScript: string;
  readonly tmpDir: string;
  readonly shareDir: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number | undefined;
}

interface RunningWorker {
  readonly id: number;
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  stdout: string;
  stderr: string;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export async function spawnInlineWorkers(
  opts: SpawnInlineWorkersOptions,
): Promise<readonly SpawnedWorker[]> {
  await mkdir(opts.tmpDir, { recursive: true });
  const scriptPath = join(opts.tmpDir, 'worker.mjs');
  await writeFile(scriptPath, opts.inlineScript, 'utf8');
  const running: RunningWorker[] = [];
  for (let id = 0; id < opts.count; id += 1) {
    const child = spawn(tsxCli, [scriptPath, String(id)], {
      env: {
        ...process.env,
        KIMI_CODE_HOME: opts.shareDir,
        KIMI_WORKER_ID: String(id),
        ...opts.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const worker: RunningWorker = {
      id,
      child,
      stdout: '',
      stderr: '',
      exit: new Promise((resolve) => {
        child.on('exit', (code, signal) => {
          resolve({ code, signal });
        });
        child.on('error', () => {
          resolve({ code: -1, signal: null });
        });
      }),
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      worker.stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      worker.stderr += chunk;
    });
    running.push(worker);
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    for (const worker of running) {
      if (worker.child.exitCode === null) worker.child.kill('SIGKILL');
    }
  }, opts.timeoutMs ?? 60_000);

  try {
    const results = await Promise.all(
      running.map(async (worker): Promise<SpawnedWorker> => {
        const exit = await worker.exit;
        return {
          id: worker.id,
          pid: worker.child.pid ?? -1,
          stdout: worker.stdout,
          stderr: worker.stderr,
          exitCode: exit.code ?? -1,
          signal: exit.signal,
        };
      }),
    );
    if (timedOut) {
      throw new Error(`spawnInlineWorkers timed out after ${String(opts.timeoutMs ?? 60_000)}ms`);
    }
    return results;
  } finally {
    clearTimeout(timer);
  }
}
