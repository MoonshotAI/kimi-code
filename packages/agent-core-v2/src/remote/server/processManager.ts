import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import type { IPty } from 'node-pty';

import { OsProcessErrors } from '#/os/interface/hostProcess';

import { RpcError, RpcErrorCode } from '#/remote/protocol/errors';
import {
  PROCESS_OUTPUT_METHOD,
  PROCESS_EXITED_METHOD,
  PROCESS_CLOSED_METHOD,
  PROCESS_WRITE_ID_CACHE_SIZE,
  type ProcessOutputStream,
  type ProcessStartResult,
  type ProcessTerminateResult,
  type ProcessWriteResult,
} from '#/remote/protocol/methods';
import {
  optionalBoolean,
  optionalInteger,
  requireAbsolutePath,
  requireParams,
  requireString,
} from './fsHandler';

interface ExitedProcessGroup {
  readonly pid: number;
  readonly tty: boolean;
  killTimer: NodeJS.Timeout | undefined;
  expiryTimer: NodeJS.Timeout | undefined;
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
  clientPaused: boolean;
  exitCode: number | null;
  closed: boolean;
  openStreams: number;
  readonly writeIds: AcceptedWriteIds;
  readonly stdinWaiters: Set<() => void>;
  killTimer: NodeJS.Timeout | undefined;
}

const EMPTY: Record<string, never> = {};

const TERMINATED_ID_CACHE_SIZE = 4096;
const EXITED_GROUP_CACHE_SIZE = 4096;
const EXITED_GROUP_RETENTION_MS = 5_000;

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

  private readonly terminatedIds = new Set<string>();
  private readonly exitedGroups = new Map<string, ExitedProcessGroup>();
  private outputPaused = false;
  private disposed = false;

  constructor(private readonly notify: (method: string, params: unknown) => void) {}

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
      argv.some((item) => typeof item !== 'string') ||
      argv[0].length === 0
    ) {
      throw new RpcError(RpcErrorCode.InvalidParams, 'argv must be a string array with a non-empty first element');
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
    if (this.processes.has(processId) || this.exitedGroups.has(processId)) {
      throw new RpcError(RpcErrorCode.InvalidRequest, `duplicate process id ${processId}`);
    }

    if (this.terminatedIds.delete(processId)) {
      throw new RpcError(
        RpcErrorCode.InvalidRequest,
        `process id ${processId} was terminated before it started`,
      );
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
      clientPaused: false,
      exitCode: null,
      closed: false,
      openStreams: tty ? 1 : 2,
      writeIds: { ids: new Set(), order: [] },
      stdinWaiters: new Set(),
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
      await this.startPipe(entry, argv as string[], cwd, spawnEnv, pipeStdin);
    }
    if (this.disposed) {

      this.processes.delete(processId);
      this.killGroup(entry, 'SIGKILL');
      throw new RpcError(RpcErrorCode.InternalError, 'server is shutting down');
    }
    entry.state = 'running';
    if (entry.terminateAfterStart) {
      this.beginTermination(entry);
    }
    return { pid: entry.pid };
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
    this.applyOutputPause(entry);
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
  ): Promise<void> {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env: spawnEnv,
      detached: true,
      windowsHide: true,
      stdio: [pipeStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    entry.child = child;
    entry.pid = child.pid ?? -1;
    this.applyOutputPause(entry);
    const stdout = child.stdout!;
    const stderr = child.stderr!;
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
    if (this.disposed || this.processes.get(entry.processId) !== entry) return;
    this.notify(PROCESS_OUTPUT_METHOD, {
      processId: entry.processId,
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
    this.notify(PROCESS_EXITED_METHOD, { processId: entry.processId, exitCode });
    this.maybeClose(entry);
  }

  private breakStdin(entry: ManagedProcess): void {
    entry.stdinOpen = false;
    const waiters = [...entry.stdinWaiters];
    entry.stdinWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private maybeClose(entry: ManagedProcess): void {
    if (this.disposed || entry.closed || entry.exitCode === null || entry.openStreams !== 0) return;
    entry.closed = true;
    this.notify(PROCESS_CLOSED_METHOD, { processId: entry.processId });
    this.processes.delete(entry.processId);
    const group: ExitedProcessGroup = {
      pid: entry.pid,
      tty: entry.tty,
      killTimer: entry.killTimer,
      expiryTimer: undefined,
    };
    group.expiryTimer = setTimeout(() => {
      if (this.exitedGroups.get(entry.processId) !== group) return;
      this.exitedGroups.delete(entry.processId);
    }, EXITED_GROUP_RETENTION_MS);
    group.expiryTimer.unref?.();
    this.exitedGroups.set(entry.processId, group);
    while (this.exitedGroups.size > EXITED_GROUP_CACHE_SIZE) {
      const oldest = this.exitedGroups.entries().next();
      if (oldest.done) break;
      const [id, group] = oldest.value;
      if (group.killTimer !== undefined) {
        clearTimeout(group.killTimer);
        this.killOrphanedGroup(group.pid, 'SIGKILL');
      }
      if (group.expiryTimer !== undefined) clearTimeout(group.expiryTimer);
      this.exitedGroups.delete(id);
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
      return { status: this.exitedGroups.has(processId) ? 'stdinClosed' : 'unknownProcess' };
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
    const nodeSignal = signal === 'interrupt' ? 'SIGINT' : signal === 'terminate' ? 'SIGTERM' : 'SIGKILL';
    const entry = this.processes.get(processId);
    if (entry === undefined) {
      const group = this.exitedGroups.get(processId);
      if (group === undefined) {
        throw new RpcError(RpcErrorCode.InvalidRequest, `unknown process id ${processId}`);
      }
      this.killOrphanedGroup(group.pid, nodeSignal);
      return EMPTY;
    }
    if (entry.state !== 'running') {
      throw new RpcError(RpcErrorCode.InvalidRequest, `process id ${processId} is starting`);
    }
    this.killGroup(entry, nodeSignal);
    return EMPTY;
  }

  async terminate(rawParams: unknown): Promise<ProcessTerminateResult> {
    const params = requireParams(rawParams);
    const processId = requireString(params, 'processId');
    const entry = this.processes.get(processId);
    if (entry === undefined) {
      const group = this.exitedGroups.get(processId);
      if (group !== undefined) {
        this.killOrphanedGroup(group.pid, 'SIGTERM');
        if (group.killTimer === undefined) {
          group.killTimer = setTimeout(() => {
            this.killOrphanedGroup(group.pid, 'SIGKILL');
            group.killTimer = undefined;
          }, 1_000);
          group.killTimer.unref?.();
        }
        return { running: false };
      }

      this.terminatedIds.add(processId);
      while (this.terminatedIds.size > TERMINATED_ID_CACHE_SIZE) {
        const oldest = this.terminatedIds.values().next();
        if (oldest.done) break;
        this.terminatedIds.delete(oldest.value);
      }
      return { running: false };
    }
    if (entry.state !== 'running') {
      entry.terminateAfterStart = true;
      return { running: true };
    }
    if (entry.exitCode !== null) {

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
    }, 1_000);
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
      const group = this.exitedGroups.get(processId);
      if (group?.tty === true) return EMPTY;
      if (group !== undefined) {
        throw new RpcError(RpcErrorCode.InvalidRequest, `process id ${processId} has no tty`);
      }
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

  private killOrphanedGroup(pgid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pgid, signal);
    } catch {

    }
  }

  setOutputPaused(paused: boolean): void {
    this.outputPaused = paused;
    for (const entry of this.processes.values()) {
      this.applyOutputPause(entry);
    }
  }

  setClientPaused(processId: string, paused: boolean): void {
    const entry = this.processes.get(processId);
    if (entry === undefined || entry.clientPaused === paused) return;
    entry.clientPaused = paused;
    this.applyOutputPause(entry);
  }

  private applyOutputPause(entry: ManagedProcess): void {
    const paused = this.outputPaused || entry.clientPaused;
    if (entry.pty !== undefined) {
      if (paused) entry.pty.pause();
      else entry.pty.resume();
      return;
    }
    const child = entry.child;
    if (child === undefined) return;
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout !== null && stdout !== undefined) {
      if (paused) stdout.pause();
      else stdout.resume();
    }
    if (stderr !== null && stderr !== undefined) {
      if (paused) stderr.pause();
      else stderr.resume();
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
    const orphanedGroups = [...this.exitedGroups.values()];
    for (const group of orphanedGroups) {
      this.killOrphanedGroup(group.pid, 'SIGTERM');
    }
    if (entries.some((entry) => entry.exitCode === null)) {
      const deadline = Date.now() + 1_000;
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
    for (const group of [...orphanedGroups, ...this.exitedGroups.values()]) {
      this.killOrphanedGroup(group.pid, 'SIGKILL');
    }
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.processes.values()) {
      if (entry.killTimer !== undefined) clearTimeout(entry.killTimer);
      this.breakStdin(entry);
    }
    this.processes.clear();
    this.terminatedIds.clear();
    for (const group of this.exitedGroups.values()) {
      if (group.killTimer !== undefined) clearTimeout(group.killTimer);
      if (group.expiryTimer !== undefined) clearTimeout(group.expiryTimer);
    }
    this.exitedGroups.clear();
  }
}
