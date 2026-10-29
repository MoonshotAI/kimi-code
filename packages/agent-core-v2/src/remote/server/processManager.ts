import { stat } from 'node:fs/promises';
import type { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { OsProcessErrors, type IHostProcess } from '#/os/interface/hostProcess';
import { PROCESS_TERMINATION_GRACE_MS } from '../processLifecycle';

import { RpcError, RpcErrorCode } from '#/remote/protocol/errors';
import {
  PROCESS_OUTPUT_METHOD,
  PROCESS_EXITED_METHOD,
  PROCESS_CLOSED_METHOD,
  type ProcessOutputStream,
  type ProcessStartResult,
} from '#/remote/protocol/methods';
import {
  optionalBoolean,
  requireAbsolutePath,
  requireParams,
  requireString,
} from './fsHandler';

interface ExitedProcessGroup {
  readonly pid: number;
  killTimer: NodeJS.Timeout | undefined;
  expiryTimer: NodeJS.Timeout | undefined;
}

interface ManagedProcess {
  readonly processId: string;
  state: 'starting' | 'running';
  pid: number;
  child: IHostProcess | undefined;
  stdinOpen: boolean;
  terminateAfterStart: boolean;
  clientPaused: boolean;
  exitCode: number | null;
  closed: boolean;
  openStreams: number;
  readonly stdinWaiters: Set<() => void>;
  killTimer: NodeJS.Timeout | undefined;
}

const EMPTY: Record<string, never> = {};

const TERMINATED_ID_CACHE_SIZE = 4096;
const GROUP_REAP_INTERVAL_MS = 5_000;

export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();

  private readonly terminatedIds = new Set<string>();
  private readonly exitedGroups = new Map<string, ExitedProcessGroup>();
  private outputPaused = false;
  private shuttingDown = false;
  private disposed = false;

  constructor(
    private readonly notify: (method: string, params: unknown) => void,
    private readonly host: HostProcessService,
  ) {}

  async start(rawParams: unknown): Promise<ProcessStartResult> {
    if (this.disposed || this.shuttingDown) {
      throw new RpcError(RpcErrorCode.InternalError, 'server is shutting down');
    }
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
      state: 'starting',
      pid: -1,
      child: undefined,
      stdinOpen: true,
      terminateAfterStart: false,
      clientPaused: false,
      exitCode: null,
      closed: false,
      openStreams: 2,
      stdinWaiters: new Set(),
      killTimer: undefined,
    };
    this.processes.set(processId, entry);

    await this.startPipe(entry, argv as string[], cwd, env as Record<string, string> | undefined);
    if (this.disposed || this.shuttingDown || entry.terminateAfterStart) {
      this.processes.delete(processId);
      this.killGroup(entry, 'SIGKILL');
      throw new RpcError(RpcErrorCode.InternalError, 'server is shutting down');
    }
    entry.state = 'running';
    if (entry.terminateAfterStart) {
      this.beginTermination(entry).catch(() => {});
    }
    return { pid: entry.pid };
  }

  private async startPipe(
    entry: ManagedProcess,
    argv: string[],
    cwd: string,
    env: Record<string, string> | undefined,
  ): Promise<void> {
    let child: IHostProcess;
    try {
      child = await this.host.spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true });
    } catch (error) {
      this.processes.delete(entry.processId);
      const cause = (error instanceof Error && error.cause !== undefined ? error.cause : error) as NodeJS.ErrnoException;
      throw new RpcError(
        RpcErrorCode.InternalError,
        `failed to spawn "${argv[0]}": ${cause.message}`,
        {
          domainCode: OsProcessErrors.codes.OS_PROCESS_SPAWN_FAILED,
          errno: cause.code,
        },
      );
    }
    entry.child = child;
    entry.pid = child.pid;
    this.applyOutputPause(entry);
    child.stdout.on('data', (chunk: Buffer) => {
      this.pump(entry, 'stdout', chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.pump(entry, 'stderr', chunk);
    });
    child.stdout.on('end', () => {
      this.onStreamEnd(entry);
    });
    child.stderr.on('end', () => {
      this.onStreamEnd(entry);
    });
    child.stdout.on('error', () => {
      this.onStreamEnd(entry);
    });
    child.stderr.on('error', () => {
      this.onStreamEnd(entry);
    });
    child.stdin.on('error', () => {
      this.breakStdin(entry);
    });
    child.wait().then(
      (code) => {
        this.onExit(entry, code);
      },
      () => {},
    );
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
      killTimer: entry.killTimer,
      expiryTimer: undefined,
    };
    this.exitedGroups.set(entry.processId, group);
    this.scheduleGroupReap(entry.processId, group);
  }

  private scheduleGroupReap(processId: string, group: ExitedProcessGroup): void {
    group.expiryTimer = setTimeout(() => {
      if (this.exitedGroups.get(processId) !== group) return;
      try {
        process.kill(-group.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          if (group.killTimer !== undefined) clearTimeout(group.killTimer);
          this.exitedGroups.delete(processId);
          return;
        }
      }
      this.scheduleGroupReap(processId, group);
    }, GROUP_REAP_INTERVAL_MS);
    group.expiryTimer.unref?.();
  }

  async write(rawParams: unknown): Promise<typeof EMPTY> {
    const params = requireParams(rawParams);
    const processId = requireString(params, 'processId');
    const chunkBase64 = params['chunkBase64'];
    if (typeof chunkBase64 !== 'string') {
      throw new RpcError(RpcErrorCode.InvalidParams, 'chunkBase64 must be a string');
    }
    const eof = optionalBoolean(params, 'eof') ?? false;
    if (eof && chunkBase64.length > 0) {
      throw new RpcError(RpcErrorCode.InvalidParams, 'eof writes must carry an empty chunk');
    }
    const entry = this.processes.get(processId);
    if (entry === undefined || !entry.stdinOpen) {
      return EMPTY;
    }
    if (eof) {
      entry.stdinOpen = false;
      entry.child?.stdin?.end();
      return EMPTY;
    }
    const chunk = Buffer.from(chunkBase64, 'base64');
    if (chunk.length > 0) {
      const stdin = entry.child?.stdin;
      if (stdin === undefined) {
        entry.stdinOpen = false;
        return EMPTY;
      }

      if (!stdin.write(chunk)) {
        await new Promise<void>((resolve) => {
          const settle = (): void => {
            stdin.off('drain', settle);
            entry.stdinWaiters.delete(settle);
            resolve();
          };
          stdin.once('drain', settle);
          entry.stdinWaiters.add(settle);
        });
      }
    }
    return EMPTY;
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
      const group = this.exitedGroups.get(processId);
      if (group !== undefined) {
        if (signal === 'terminate') {
          this.killOrphanedGroup(group.pid, 'SIGTERM');
          if (group.killTimer === undefined) {
            group.killTimer = setTimeout(() => {
              this.killOrphanedGroup(group.pid, 'SIGKILL');
              group.killTimer = undefined;
            }, PROCESS_TERMINATION_GRACE_MS);
            group.killTimer.unref?.();
          }
          return EMPTY;
        }
        this.killOrphanedGroup(group.pid, signal === 'interrupt' ? 'SIGINT' : 'SIGKILL');
        return EMPTY;
      }
      if (signal === 'terminate') {
        this.terminatedIds.add(processId);
        while (this.terminatedIds.size > TERMINATED_ID_CACHE_SIZE) {
          const oldest = this.terminatedIds.values().next();
          if (oldest.done) break;
          this.terminatedIds.delete(oldest.value);
        }
        return EMPTY;
      }
      throw new RpcError(RpcErrorCode.InvalidRequest, `unknown process id ${processId}`);
    }
    if (entry.state !== 'running') {
      if (signal === 'terminate') {
        entry.terminateAfterStart = true;
        return EMPTY;
      }
      throw new RpcError(RpcErrorCode.InvalidRequest, `process id ${processId} is starting`);
    }
    if (signal === 'terminate') {
      await this.beginTermination(entry);
      return EMPTY;
    }
    await entry.child?.kill(signal === 'interrupt' ? 'SIGINT' : 'SIGKILL');
    return EMPTY;
  }

  private async beginTermination(entry: ManagedProcess): Promise<void> {
    await entry.child?.kill('SIGTERM');
    entry.killTimer = setTimeout(() => {
      this.killGroup(entry, 'SIGKILL');
    }, PROCESS_TERMINATION_GRACE_MS);
    entry.killTimer.unref?.();
  }

  private killGroup(entry: ManagedProcess, signal: NodeJS.Signals): void {
    entry.child?.kill(signal).catch(() => {});
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
    const child = entry.child;
    if (child === undefined) return;
    for (const stream of [child.stdout, child.stderr]) {
      if (paused) stream.pause();
      else stream.resume();
    }
  }

  async terminateAll(): Promise<void> {
    if (this.disposed || this.shuttingDown) return;
    this.shuttingDown = true;
    const entries = [...this.processes.values()];
    for (const entry of entries) {
      if (entry.state === 'starting') entry.terminateAfterStart = true;
    }
    for (const entry of entries) {
      this.killGroup(entry, 'SIGTERM');
    }
    const orphanedGroups = [...this.exitedGroups.values()];
    for (const group of orphanedGroups) {
      this.killOrphanedGroup(group.pid, 'SIGTERM');
    }
    if (entries.some((entry) => entry.exitCode === null)) {
      const deadline = Date.now() + PROCESS_TERMINATION_GRACE_MS;
      while (Date.now() < deadline) {
        if (entries.every((entry) => entry.exitCode !== null)) break;
        await new Promise((resolve) => {
          setTimeout(resolve, 25);
        });
      }
    }
    for (const entry of entries) {
      this.killGroup(entry, 'SIGKILL');
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
