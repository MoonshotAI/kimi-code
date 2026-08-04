/**
 * `acp-terminal` — ACP-backed `ISessionProcessRunner`, the Slice-5 terminal
 * reverse-RPC bridge.
 *
 * Registered at AGENT scope so it shadows the handler-seeded workspace runner
 * for Agent-scope consumers (the Bash tool resolves `ISessionProcessRunner`
 * at Agent scope). A Session-scope registration would lose to the
 * `sessionLifecycleService` seed — `buildCollection` applies seeds after
 * registered descriptors on the same scope level — while a child scope's own
 * collection is consulted before the parent's (see `test/di-shadow.test.ts`).
 *
 * Capability gating: when the client did not advertise
 * `clientCapabilities.terminal` (`IAcpConnection.terminalEnabled`), or the
 * invocation does not look like a Bash-tool shell command, `exec` delegates
 * to a local spawn with the exact semantics of the engine's
 * `SessionProcessRunner` (per-call cwd wins over the session cwd; a per-call
 * env is overlaid onto `process.env`). Behavior with the capability off is
 * therefore identical to today's.
 *
 * Terminal lifecycle (capability on):
 *   `terminal/create`        — once per `exec` (the client runs the command)
 *   `terminal/output`        — polled while running; deltas feed `stdout`
 *   `terminal/wait_for_exit` — resolves `IProcess.wait()` with the exit code
 *   `terminal/kill`          — `IProcess.kill()` (SIGTERM/SIGKILL both map here;
 *                              the client owns the actual signal semantics)
 *   `terminal/release`       — `IProcess.dispose()` (frees the terminal; the
 *                              client kills the command if it is still running)
 *
 * Output de-duplication is handled by the adapter (`AcpSession`), which
 * attaches a `{type: 'terminal'}` content entry to the tool card and
 * suppresses the textual tool-result content for terminal-backed calls — the
 * model still receives the full captured output, only the client card is
 * de-duplicated.
 */

import { PassThrough, Writable, type Readable } from 'node:stream';

import {
  IHostProcessService,
  type IProcess,
  ISessionContext,
  ISessionProcessRunner,
  LifecycleScope,
  type ProcessExecOptions,
  registerScopedService,
  ScopeActivation,
} from '@moonshot-ai/agent-core-v2';

import { IAcpConnection, type IAcpTerminalHandle } from '../acp-fs';

/** Retained-output ceiling handed to the client on `terminal/create`. */
const OUTPUT_BYTE_LIMIT = 4 * 1024 * 1024;
/** Polling cadence for `terminal/output` while the command runs. */
const OUTPUT_POLL_MS = 250;

/**
 * Whether an `exec` call is the Bash tool's shell invocation. The Bash tool
 * always spawns `[shellPath, '-c', 'cd <cwd> && <command>']` with the
 * noninteractive env `{ NO_COLOR: '1', TERM: 'dumb', … }`; other Agent-scope
 * callers (e.g. profile prompt-prefix commands) do not. Only Bash-tool
 * invocations get a client-visible terminal — internal commands stay local.
 */
function isBashToolInvocation(args: readonly string[], options?: ProcessExecOptions): boolean {
  return (
    args.length === 3 &&
    args[1] === '-c' &&
    options?.env?.['NO_COLOR'] === '1' &&
    options?.env?.['TERM'] === 'dumb'
  );
}

function envRecordToAcp(
  env: Record<string, string> | undefined,
): Array<{ name: string; value: string }> | undefined {
  if (env === undefined) return undefined;
  return Object.entries(env).map(([name, value]) => ({ name, value }));
}

export class AcpProcessRunner implements ISessionProcessRunner {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionContext private readonly ctx: ISessionContext,
    @IAcpConnection private readonly connection: IAcpConnection,
    @IHostProcessService private readonly hostProcess: IHostProcessService,
  ) {}

  async exec(args: readonly string[], options?: ProcessExecOptions): Promise<IProcess> {
    const command = args[0];
    if (command === undefined) {
      throw new Error(
        'AcpProcessRunner.exec(): at least one argument (the command to run) is required.',
      );
    }
    if (!this.connection.terminalEnabled || !isBashToolInvocation(args, options)) {
      return this.execLocal(command, args.slice(1), options);
    }

    const handle = await this.connection.get().createTerminal({
      sessionId: this.ctx.sessionId,
      command,
      args: args.slice(1),
      env: envRecordToAcp(options?.env),
      cwd: options?.cwd ?? this.ctx.cwd,
      outputByteLimit: OUTPUT_BYTE_LIMIT,
    });
    // Tell the adapter which shell command this terminal runs so it can
    // correlate the terminal with the in-flight Bash tool call.
    this.connection.notifyTerminalCreated({
      sessionId: this.ctx.sessionId,
      shellCommand: args[2] ?? '',
      terminalId: handle.id,
    });
    return new AcpTerminalProcess(handle);
  }

  /**
   * Local fallback with the engine `SessionProcessRunner` semantics: default
   * cwd from the session context, per-call env overlaid onto `process.env`.
   */
  private execLocal(
    command: string,
    restArgs: readonly string[],
    options?: ProcessExecOptions,
  ): Promise<IProcess> {
    const cwd = options?.cwd ?? this.ctx.cwd;
    const env =
      options?.env === undefined
        ? undefined
        : { ...(process.env as Record<string, string>), ...options.env };
    return this.hostProcess.spawn(command, restArgs, { cwd, env });
  }
}

/**
 * `IProcess` over an ACP client terminal. The terminal protocol exposes a
 * single combined output stream (no stdout/stderr split), so `stdout`
 * carries the polled output deltas and `stderr` stays empty. `stdin` is a
 * sink — the protocol has no input channel.
 */
class AcpTerminalProcess implements IProcess {
  readonly stdin: Writable;
  readonly stdout: PassThrough;
  readonly stderr: Readable;
  /** ACP terminals expose no pid; reported as 0 in background-task metadata. */
  readonly pid = 0;

  private _exitCode: number | null = null;
  /** Bytes of client output already forwarded to `stdout`. */
  private emitted = 0;
  private readonly pollTimer: ReturnType<typeof setInterval>;
  private readonly waitPromise: Promise<number>;
  private released = false;

  constructor(private readonly handle: IAcpTerminalHandle) {
    this.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    this.stdout = new PassThrough();
    const stderr = new PassThrough();
    stderr.end();
    this.stderr = stderr;

    const waitPromise = this.run();
    // Mark the rejection as handled: `wait()` consumers still observe it, but
    // paths that kill+dispose without awaiting (spawn-error cleanup) must not
    // crash the process with an unhandled rejection.
    waitPromise.catch(() => {});
    this.waitPromise = waitPromise;

    this.pollTimer = setInterval(() => {
      void this.pump();
    }, OUTPUT_POLL_MS);
    this.pollTimer.unref?.();
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  wait(): Promise<number> {
    return this.waitPromise;
  }

  async kill(_signal?: NodeJS.Signals): Promise<void> {
    // The protocol has a single kill operation; the client decides the
    // signal. The terminal stays valid afterwards (final output still
    // readable), matching the two-phase kill the task service performs.
    await this.handle.kill();
  }

  async dispose(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.stopPolling();
    try {
      await this.handle.release();
    } catch {
      // Best-effort — teardown must never throw.
    }
  }

  private async run(): Promise<number> {
    const status = await this.handle.waitForExit();
    // Mirror the host process semantics: signal termination reports -1.
    this._exitCode = status.exitCode ?? -1;
    // Final flush catches output produced between the last poll and exit.
    await this.pump();
    this.stopPolling();
    this.stdout.end();
    return this._exitCode;
  }

  /** Forward newly-retained client output to `stdout`. */
  private async pump(): Promise<void> {
    try {
      const { output } = await this.handle.currentOutput();
      if (output.length > this.emitted) {
        this.stdout.write(output.slice(this.emitted));
        this.emitted = output.length;
      } else if (output.length < this.emitted) {
        // The client truncated from the beginning to stay under the byte
        // limit; the rotated-away middle is unrecoverable — skip ahead
        // instead of re-emitting.
        this.emitted = output.length;
      }
    } catch {
      // The terminal may be released mid-poll; the stream ends via run().
    }
  }

  private stopPolling(): void {
    clearInterval(this.pollTimer);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  ISessionProcessRunner,
  AcpProcessRunner,
  ScopeActivation.OnDemand,
  'acp',
);
