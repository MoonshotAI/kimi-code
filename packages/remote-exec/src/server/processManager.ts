import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import type { IPty } from 'node-pty';

import { OsProcessErrors } from '@moonshot-ai/agent-core-v2/os/interface/hostProcess';

import { RpcError, RpcErrorCode } from '#/protocol/errors';
import {
  PROCESS_EXITED_RETENTION_MS,
  PROCESS_OUTPUT_METHOD,
  PROCESS_EXITED_METHOD,
  PROCESS_CLOSED_METHOD,
  PROCESS_REPLAY_MAX_BYTES,
  PROCESS_REPLAY_MAX_CHUNKS,
  PROCESS_WRITE_ID_CACHE_SIZE,
  type ProcessOutputStream,
  type ProcessReadChunk,
  type ProcessReadResult,
  type ProcessStartResult,
  type ProcessTerminateResult,
  type ProcessWriteResult,
} from '#/protocol/methods';
import {
  optionalBoolean,
  optionalInteger,
  requireAbsolutePath,
  requireParams,
  requireString,
} from './fsHandler';

export interface ProcessManagerTuning {
  readonly exitedRetentionMs?: number;
  readonly terminateEscalationMs?: number;
}

interface RetainedChunk {
  readonly seq: number;
  readonly stream: ProcessOutputStream;
  readonly chunk: Buffer;
}

interface AcceptedWriteIds {
  readonly ids: Set<string>;
  readonly order: string[];
}

interface ManagedProcess {
  readonly processId: string;
  readonly tty: boolean;
  readonly pipeStdin: boolean;
  state: 'starting' | 'running';
  pid: number;
  child: ChildProcess | undefined;
  pty: IPty | undefined;
  stdinOpen: boolean;
  terminateAfterStart: boolean;
  nextSeq: number;
  readonly retained: RetainedChunk[];
  retainedBytes: number;
  exitCode: number | null;
  closed: boolean;
  openStreams: number;
  readonly writeIds: AcceptedWriteIds;
  readonly waiters: Set<() => void>;
  readonly stdinWaiters: Set<() => void>;
  removalTimer: NodeJS.Timeout | undefined;
  killTimer: NodeJS.Timeout | undefined;
}

export interface ProcessManagerHost {
  notify(method: string, params: unknown): void;
}

const EMPTY: Record<string, never> = {};

function rememberWriteId(writeIds: AcceptedWriteIds, writeId: string): void {
  if (writeIds.ids.has(writeId)) return;
  writeIds.ids.add(writeId);
  writeIds.order.push(writeId);
  while (writeIds.order.length > PROCESS_WRITE_ID_CACHE_SIZE) {
    const evicted = writeIds.order.shift();
    if (evicted === undefined) break;
    writeIds.ids.delete(evicted);
  }
}

export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();
  private outputPaused = false;
  private disposed = false;

  constructor(
    private readonly host: ProcessManagerHost,
    private readonly tuning: ProcessManagerTuning = {},
  ) {}

  async start(rawParams: unknown): Promise<ProcessStartResult> {
    const params = requireParams(rawParams);
    const processId = requireString(params, 'processId');
    if (processId.length > 128) {
      throw new RpcError(RpcErrorCode.InvalidParams, 'processId must be at most 128 characters');
    }
    const argv = params['argv'];
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      argv.some((item) => typeof item !== 'string' || item.length === 0)
    ) {
      throw new RpcError(RpcErrorCode.InvalidParams, 'argv must be a non-empty string array');
    }
    const cwd = requireAbsolutePath(params, 'cwd');
    const cwdStat = await stat(cwd).catch(() => undefined);
    if (cwdStat === undefined || !cwdStat.isDirectory()) {
      throw new RpcError(
        RpcErrorCode.InvalidParams,
        `cwd ${cwd} does not exist or is not a directory`,
        {
          domainCode: OsProcessErrors.codes.OS_PROCESS_SPAWN_FAILED,
          cwd,
        },
      );
    }
    const env = params['env'];
    if (env !== undefined) {
      if (env === null || typeof env !== 'object' || Array.isArray(env)) {
        throw new RpcError(RpcErrorCode.InvalidParams, 'env must be an object of string values');
      }
      for (const [key, value] of Object.entries(env)) {
        if (typeof value !== 'string') {
          throw new RpcError(RpcErrorCode.InvalidParams, `env.${key} must be a string`);
        }
      }
    }
    const tty = optionalBoolean(params, 'tty') ?? false;
    const pipeStdin = optionalBoolean(params, 'pipeStdin') ?? false;
    const arg0 = params['arg0'];
    if (arg0 !== undefined && typeof arg0 !== 'string') {
      throw new RpcError(RpcErrorCode.InvalidParams, 'arg0 must be a string');
    }
    if (this.processes.has(processId)) {
      throw new RpcError(RpcErrorCode.InvalidRequest, `duplicate process id ${processId}`);
    }

    const entry: ManagedProcess = {
      processId,
      tty,
      pipeStdin,
      state: 'starting',
      pid: -1,
      child: undefined,
      pty: undefined,
      stdinOpen: tty || pipeStdin,
      terminateAfterStart: false,
      nextSeq: 1,
      retained: [],
      retainedBytes: 0,
      exitCode: null,
      closed: false,
      openStreams: tty ? 1 : 2,
      writeIds: { ids: new Set(), order: [] },
      waiters: new Set(),
      stdinWaiters: new Set(),
      removalTimer: undefined,
      killTimer: undefined,
    };
    this.processes.set(processId, entry);

    const spawnEnv =
      env === undefined
        ? undefined
        : { ...(process.env as Record<string, string>), ...(env as Record<string, string>) };

    if (tty) {
      await this.startPty(entry, argv as string[], cwd, spawnEnv);
    } else {
      await this.startPipe(entry, argv as string[], cwd, spawnEnv, pipeStdin, arg0);
    }
    if (this.disposed) {
      // Shutdown raced the spawn: the entry was dropped with the map, so kill
      // the child right away rather than leaving an unmanaged orphan.
      this.processes.delete(processId);
      this.killGroup(entry, 'SIGKILL');
      throw new RpcError(RpcErrorCode.InternalError, 'server is shutting down');
    }
    entry.state = 'running';
    if (entry.terminateAfterStart) {
      this.beginTermination(entry);
    }
    return { processId, pid: entry.pid };
  }

  private async startPty(
    entry: ManagedProcess,
    argv: string[],
    cwd: string,
    spawnEnv: Record<string, string> | undefined,
  ): Promise<void> {
    let pty: IPty;
    try {
      const nodePty = await import('node-pty');
      pty = nodePty.spawn(argv[0]!, argv.slice(1), {
        name: 'xterm-256color',
        cwd,
        cols: 80,
        rows: 24,
        env: spawnEnv ?? (process.env as Record<string, string>),
      });
    } catch (error) {
      this.processes.delete(entry.processId);
      const err = error as Error;
      throw new RpcError(RpcErrorCode.InternalError, `failed to spawn tty process: ${err.message}`, {
        domainCode: OsProcessErrors.codes.OS_PROCESS_SPAWN_FAILED,
      });
    }
    entry.pty = pty;
    entry.pid = pty.pid;
    if (this.outputPaused) pty.pause();
    pty.onData((data) => {
      this.pump(entry, 'pty', Buffer.from(data, 'utf8'));
    });
    pty.onExit(({ exitCode }) => {
      entry.openStreams = 0;
      this.onExit(entry, exitCode);
    });
  }

  private async startPipe(
    entry: ManagedProcess,
    argv: string[],
    cwd: string,
    spawnEnv: Record<string, string> | undefined,
    pipeStdin: boolean,
    arg0: string | undefined,
  ): Promise<void> {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env: spawnEnv,
      detached: true,
      argv0: arg0,
      windowsHide: true,
      stdio: [pipeStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    entry.child = child;
    entry.pid = child.pid ?? -1;
    const stdout = child.stdout!;
    const stderr = child.stderr!;
    if (this.outputPaused) {
      stdout.pause();
      stderr.pause();
    }
    stdout.on('data', (chunk: Buffer) => {
      this.pump(entry, 'stdout', chunk);
    });
    stderr.on('data', (chunk: Buffer) => {
      this.pump(entry, 'stderr', chunk);
    });
    stdout.on('end', () => {
      this.onStreamEnd(entry);
    });
    stderr.on('end', () => {
      this.onStreamEnd(entry);
    });
    stdout.on('error', () => {
      this.onStreamEnd(entry);
    });
    stderr.on('error', () => {
      this.onStreamEnd(entry);
    });
    if (pipeStdin && child.stdin !== null) {
      child.stdin.on('error', () => {
        this.breakStdin(entry);
      });
    }
    child.on('exit', (code) => {
      this.onExit(entry, code ?? -1);
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => {
        resolve();
      });
      child.once('error', (error: NodeJS.ErrnoException) => {
        reject(error);
      });
    }).catch((error: NodeJS.ErrnoException) => {
      this.processes.delete(entry.processId);
      throw new RpcError(
        RpcErrorCode.InternalError,
        `failed to spawn "${argv[0]}": ${error.message}`,
        {
          domainCode: OsProcessErrors.codes.OS_PROCESS_SPAWN_FAILED,
          errno: error.code,
        },
      );
    });
  }

  private pump(entry: ManagedProcess, stream: ProcessOutputStream, chunk: Buffer): void {
    if (this.processes.get(entry.processId) !== entry) return;
    const seq = entry.nextSeq;
    entry.nextSeq += 1;
    entry.retained.push({ seq, stream, chunk });
    entry.retainedBytes += chunk.length;
    while (
      entry.retainedBytes > PROCESS_REPLAY_MAX_BYTES ||
      entry.retained.length > PROCESS_REPLAY_MAX_CHUNKS
    ) {
      const evicted = entry.retained.shift();
      if (evicted === undefined) break;
      entry.retainedBytes = Math.max(0, entry.retainedBytes - evicted.chunk.length);
    }
    this.wake(entry);
    this.host.notify(PROCESS_OUTPUT_METHOD, {
      processId: entry.processId,
      seq,
      stream,
      chunkBase64: chunk.toString('base64'),
    });
  }

  private onStreamEnd(entry: ManagedProcess): void {
    if (entry.openStreams > 0) entry.openStreams -= 1;
    this.maybeClose(entry);
  }

  private onExit(entry: ManagedProcess, exitCode: number): void {
    if (this.processes.get(entry.processId) !== entry) return;
    if (entry.exitCode !== null) return;
    entry.exitCode = exitCode;
    this.breakStdin(entry);
    const seq = entry.nextSeq;
    entry.nextSeq += 1;
    this.wake(entry);
    this.host.notify(PROCESS_EXITED_METHOD, { processId: entry.processId, seq, exitCode });
    this.maybeClose(entry);
    entry.removalTimer = setTimeout(() => {
      this.processes.delete(entry.processId);
      this.wake(entry);
    }, this.tuning.exitedRetentionMs ?? PROCESS_EXITED_RETENTION_MS);
    entry.removalTimer.unref?.();
  }

  private breakStdin(entry: ManagedProcess): void {
    entry.stdinOpen = false;
    const waiters = [...entry.stdinWaiters];
    entry.stdinWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private maybeClose(entry: ManagedProcess): void {
    if (entry.closed || entry.exitCode === null || entry.openStreams !== 0) return;
    entry.closed = true;
    const seq = entry.nextSeq;
    entry.nextSeq += 1;
    this.wake(entry);
    this.host.notify(PROCESS_CLOSED_METHOD, { processId: entry.processId, seq });
  }

  private wake(entry: ManagedProcess): void {
    const waiters = [...entry.waiters];
    entry.waiters.clear();
    for (const resolve of waiters) resolve();
  }

  private requireProcess(processId: string): ManagedProcess {
    const entry = this.processes.get(processId);
    if (entry === undefined) {
      throw new RpcError(RpcErrorCode.InvalidRequest, `unknown process id ${processId}`);
    }
    if (entry.state !== 'running') {
      throw new RpcError(RpcErrorCode.InvalidRequest, `process id ${processId} is starting`);
    }
    return entry;
  }

  async read(rawParams: unknown): Promise<ProcessReadResult> {
    const params = requireParams(rawParams);
    const processId = requireString(params, 'processId');
    const afterSeq = optionalInteger(params, 'afterSeq', 0, Number.MAX_SAFE_INTEGER) ?? 0;
    const maxBytes = optionalInteger(params, 'maxBytes', 1, Number.MAX_SAFE_INTEGER);
    const budget = maxBytes ?? Number.MAX_SAFE_INTEGER;
    const waitMs = optionalInteger(params, 'waitMs', 0, 60_000) ?? 0;
    const deadline = Date.now() + waitMs;

    for (;;) {
      const entry = this.requireProcess(processId);
      const chunks: ProcessReadChunk[] = [];
      let totalBytes = 0;
      let nextSeq = entry.nextSeq;
      for (const retained of entry.retained) {
        if (retained.seq <= afterSeq) continue;
        if (chunks.length > 0 && totalBytes + retained.chunk.length > budget) break;
        totalBytes += retained.chunk.length;
        chunks.push({
          seq: retained.seq,
          stream: retained.stream,
          chunkBase64: retained.chunk.toString('base64'),
        });
        nextSeq = retained.seq + 1;
        if (totalBytes >= budget) break;
      }
      if (maxBytes === undefined) {
        nextSeq = entry.nextSeq;
      }
      const exited = entry.exitCode !== null;
      const response: ProcessReadResult = {
        chunks,
        nextSeq,
        exited,
        exitCode: entry.exitCode ?? undefined,
        closed: entry.closed,
      };
      const hasNewTerminalEvent = exited && afterSeq < nextSeq - 1;
      if (chunks.length > 0 || entry.closed || hasNewTerminalEvent || Date.now() >= deadline) {
        return response;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return response;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          entry.waiters.delete(done);
          resolve();
        }, remaining);
        const done = (): void => {
          clearTimeout(timer);
          resolve();
        };
        entry.waiters.add(done);
      });
    }
  }

  async write(rawParams: unknown): Promise<ProcessWriteResult> {
    const params = requireParams(rawParams);
    const processId = requireString(params, 'processId');
    const chunkBase64 = params['chunkBase64'];
    if (typeof chunkBase64 !== 'string') {
      throw new RpcError(RpcErrorCode.InvalidParams, 'chunkBase64 must be a string');
    }
    const writeId = requireString(params, 'writeId');
    const eof = optionalBoolean(params, 'eof') ?? false;
    if (eof && chunkBase64.length > 0) {
      throw new RpcError(RpcErrorCode.InvalidParams, 'eof writes must carry an empty chunk');
    }
    const entry = this.processes.get(processId);
    if (entry === undefined) {
      return { status: 'unknownProcess' };
    }
    if (entry.state !== 'running') {
      return { status: 'starting' };
    }
    if (!entry.tty && !entry.pipeStdin) {
      return { status: 'stdinClosed' };
    }
    if (!entry.stdinOpen) {
      return { status: 'stdinClosed' };
    }
    if (entry.writeIds.ids.has(writeId)) {
      return { status: 'accepted' };
    }
    // Record before any await (codex ordering): a concurrent replay of the
    // same writeId must not write twice, whatever happens below.
    rememberWriteId(entry.writeIds, writeId);
    if (eof) {
      entry.stdinOpen = false;
      if (entry.pty !== undefined) {
        entry.pty.write('\u0004');
      } else {
        entry.child?.stdin?.end();
      }
      return { status: 'accepted' };
    }
    const chunk = Buffer.from(chunkBase64, 'base64');
    if (chunk.length > 0) {
      if (entry.pty !== undefined) {
        entry.pty.write(chunk.toString('utf8'));
      } else {
        const stdin = entry.child?.stdin;
        if (stdin === null || stdin === undefined) {
          entry.stdinOpen = false;
          return { status: 'stdinClosed' };
        }
        // Propagate backpressure through the RPC response so a write flood
        // cannot outpace a slow reader into unbounded server-side buffering.
        if (!stdin.write(chunk)) {
          const settled = await new Promise<'drain' | 'broken'>((resolve) => {
            const cleanup = (): void => {
              stdin.off('drain', onDrain);
              entry.stdinWaiters.delete(onBroken);
            };
            const onDrain = (): void => {
              cleanup();
              resolve('drain');
            };
            const onBroken = (): void => {
              cleanup();
              resolve('broken');
            };
            stdin.once('drain', onDrain);
            entry.stdinWaiters.add(onBroken);
          });
          if (settled === 'broken' || !entry.stdinOpen) {
            return { status: 'stdinClosed' };
          }
        }
      }
    }
    return { status: 'accepted' };
  }

  async signal(rawParams: unknown): Promise<typeof EMPTY> {
    const params = requireParams(rawParams);
    const processId = requireString(params, 'processId');
    const signal = params['signal'];
    if (signal !== 'interrupt' && signal !== 'terminate' && signal !== 'kill') {
      throw new RpcError(RpcErrorCode.InvalidParams, 'signal must be interrupt, terminate or kill');
    }
    const entry = this.processes.get(processId);
    if (entry === undefined) {
      throw new RpcError(RpcErrorCode.InvalidRequest, `unknown process id ${processId}`);
    }
    if (entry.state !== 'running') {
      throw new RpcError(RpcErrorCode.InvalidRequest, `process id ${processId} is starting`);
    }
    const nodeSignal = signal === 'interrupt' ? 'SIGINT' : signal === 'terminate' ? 'SIGTERM' : 'SIGKILL';
    this.killGroup(entry, nodeSignal);
    return EMPTY;
  }

  async terminate(rawParams: unknown): Promise<ProcessTerminateResult> {
    const params = requireParams(rawParams);
    const processId = requireString(params, 'processId');
    const entry = this.processes.get(processId);
    if (entry === undefined) {
      return { running: false };
    }
    if (entry.state !== 'running') {
      entry.terminateAfterStart = true;
      return { running: true };
    }
    if (entry.exitCode !== null) {
      // The leader is gone but the process group may hold residue: clean it.
      this.beginTermination(entry);
      return { running: false };
    }
    this.beginTermination(entry);
    return { running: true };
  }

  private beginTermination(entry: ManagedProcess): void {
    this.killGroup(entry, 'SIGTERM');
    entry.killTimer = setTimeout(() => {
      try {
        this.killGroup(entry, 'SIGKILL');
      } catch {
      }
    }, this.tuning.terminateEscalationMs ?? 1_000);
    entry.killTimer.unref?.();
  }

  async resize(rawParams: unknown): Promise<typeof EMPTY> {
    const params = requireParams(rawParams);
    const processId = requireString(params, 'processId');
    const cols = optionalInteger(params, 'cols', 1, 10_000);
    const rows = optionalInteger(params, 'rows', 1, 10_000);
    if (cols === undefined || rows === undefined) {
      throw new RpcError(RpcErrorCode.InvalidParams, 'cols and rows are required');
    }
    const entry = this.processes.get(processId);
    if (entry === undefined) {
      throw new RpcError(RpcErrorCode.InvalidRequest, `unknown process id ${processId}`);
    }
    if (!entry.tty || entry.pty === undefined) {
      throw new RpcError(RpcErrorCode.InvalidRequest, `process id ${processId} has no tty`);
    }
    if (entry.exitCode !== null) {
      return EMPTY;
    }
    entry.pty.resize(cols, rows);
    return EMPTY;
  }

  private killGroup(entry: ManagedProcess, signal: NodeJS.Signals): void {
    if (entry.pid <= 0) return;
    try {
      process.kill(-entry.pid, signal);
      return;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ESRCH') return;
      if (err.code !== 'EPERM') throw error;
    }
    try {
      if (entry.pty !== undefined) {
        entry.pty.kill(signal);
      } else {
        entry.child?.kill(signal);
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ESRCH') throw error;
    }
  }

  setOutputPaused(paused: boolean): void {
    this.outputPaused = paused;
    for (const entry of this.processes.values()) {
      if (entry.state !== 'running') continue;
      if (entry.pty !== undefined) {
        if (paused) entry.pty.pause();
        else entry.pty.resume();
      } else if (entry.child !== undefined) {
        const stdout = entry.child.stdout;
        const stderr = entry.child.stderr;
        if (stdout !== null && stdout !== undefined) {
          if (paused) stdout.pause();
          else stdout.resume();
        }
        if (stderr !== null && stderr !== undefined) {
          if (paused) stderr.pause();
          else stderr.resume();
        }
      }
    }
  }

  async terminateAll(): Promise<void> {
    if (this.disposed) return;
    const entries = [...this.processes.values()].filter((entry) => entry.state === 'running');
    for (const entry of entries) {
      try {
        this.killGroup(entry, 'SIGTERM');
      } catch {
      }
    }
    if (entries.some((entry) => entry.exitCode === null)) {
      const deadline = Date.now() + (this.tuning.terminateEscalationMs ?? 1_000);
      while (Date.now() < deadline) {
        if (entries.every((entry) => entry.exitCode !== null)) break;
        await new Promise((resolve) => {
          setTimeout(resolve, 25);
        });
      }
    }
    for (const entry of entries) {
      try {
        this.killGroup(entry, 'SIGKILL');
      } catch {
      }
    }
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.processes.values()) {
      if (entry.removalTimer !== undefined) clearTimeout(entry.removalTimer);
      if (entry.killTimer !== undefined) clearTimeout(entry.killTimer);
      this.wake(entry);
      this.breakStdin(entry);
    }
    this.processes.clear();
  }
}
