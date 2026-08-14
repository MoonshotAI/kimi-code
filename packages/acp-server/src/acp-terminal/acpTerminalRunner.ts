import * as posixPath from 'node:path/posix';
import { PassThrough, Writable, type Readable } from 'node:stream';

import type {
  HostProcessOptions,
  IHostProcess,
  IHostProcessService,
  Runtime,
  RuntimeProviderAttachment,
  RuntimeProviderContext,
  RuntimeProviderFactory,
  RuntimeProviderHost,
} from '@moonshot-ai/agent-core-v2';

import { IAcpConnection, type IAcpTerminalHandle } from '../acp-fs';

const OUTPUT_BYTE_LIMIT = 4 * 1024 * 1024;
const OUTPUT_POLL_MS = 250;
let nextGeneration = 1;

function isBashToolInvocation(args: readonly string[], options?: HostProcessOptions): boolean {
  return (
    args.length === 2 &&
    args[0] === '-c' &&
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

class AcpProcessService implements IHostProcessService {
  declare readonly _serviceBrand: undefined;

  constructor(
    private readonly sessionId: string,
    private readonly cwd: string,
    private readonly connection: IAcpConnection,
  ) {}

  async spawn(
    command: string,
    args: readonly string[] = [],
    options?: HostProcessOptions,
  ): Promise<IHostProcess> {
    if (!this.connection.terminalEnabled) {
      throw new Error('ACP terminal capability is unavailable');
    }
    if (!isBashToolInvocation(args, options)) {
      throw new Error('ACP runtime only supports interactive Bash tool processes');
    }

    const handle = await this.connection.get().createTerminal({
      sessionId: this.sessionId,
      command,
      args: [...args],
      env: envRecordToAcp(options?.env),
      cwd: options?.cwd ?? this.cwd,
      outputByteLimit: OUTPUT_BYTE_LIMIT,
    });
    this.connection.notifyTerminalCreated({
      sessionId: this.sessionId,
      shellCommand: args[1] ?? '',
      terminalId: handle.id,
    });
    return new AcpTerminalProcess(handle);
  }
}

class AcpTerminalProcess implements IHostProcess {
  declare readonly _serviceBrand: undefined;
  readonly stdin: Writable;
  readonly stdout: PassThrough;
  readonly stderr: Readable;
  readonly pid = 0;

  private _exitCode: number | null = null;
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
    await this.handle.kill();
  }

  async dispose(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.stopPolling();
    try {
      await this.handle.release();
    } catch {
    }
  }

  private async run(): Promise<number> {
    const status = await this.handle.waitForExit();
    this._exitCode = status.exitCode ?? -1;
    await this.pump();
    this.stopPolling();
    this.stdout.end();
    return this._exitCode;
  }

  private async pump(): Promise<void> {
    try {
      const { output } = await this.handle.currentOutput();
      if (output.length > this.emitted) {
        this.stdout.write(output.slice(this.emitted));
        this.emitted = output.length;
      } else if (output.length < this.emitted) {
        this.emitted = output.length;
      }
    } catch {
    }
  }

  private stopPolling(): void {
    clearInterval(this.pollTimer);
  }
}

class AcpSessionRuntime implements Runtime {
  readonly identity;
  readonly capabilities = new Set(['process'] as const);
  readonly environment = {
    osKind: 'Linux' as const,
    osArch: 'acp',
    osVersion: 'acp',
    shellName: 'bash' as const,
    shellPath: '/bin/bash',
    pathClass: 'posix' as const,
    homeDir: '/',
  };
  readonly path = {
    separator: '/' as const,
    delimiter: ':' as const,
    isAbsolute: (p: string) => posixPath.isAbsolute(p),
    join: (...paths: readonly string[]) => posixPath.join(...paths),
    relative: (from: string, to: string) => posixPath.relative(from, to),
    resolve: (...paths: readonly string[]) => posixPath.resolve(...paths),
  };
  readonly workspace = { mapRoots: (roots: { workDir: string; additionalDirs?: readonly string[] }) => roots };
  readonly fs = undefined;
  readonly process;
  readonly watch = undefined;
  readonly terminal = undefined;
  readonly status = 'ready' as const;
  readonly onDidChangeStatus = () => ({ dispose: () => {} });

  constructor(
    workspaceId: string,
    sessionId: string,
    cwd: string,
    connection: IAcpConnection,
  ) {
    this.identity = {
      workspaceId,
      runtimeId: AcpRuntimeProviderFactory.runtimeId(sessionId),
      generation: `acp-${String(nextGeneration++)}`,
    };
    this.process = new AcpProcessService(sessionId, cwd, connection);
  }

  dispose(): void {}
}

class AcpWorkspaceRuntimeAttachment implements RuntimeProviderAttachment {
  private readonly sessions = new Map<string, { remove(): Promise<void> }>();

  constructor(
    private readonly workspace: RuntimeProviderContext,
    private readonly host: RuntimeProviderHost,
    private readonly connection: IAcpConnection,
  ) {}

  bindSession(sessionId: string, cwd: string): string {
    const runtimeId = AcpRuntimeProviderFactory.runtimeId(sessionId);
    if (this.sessions.has(sessionId)) return runtimeId;
    const registration = this.host.registerRuntime(
      new AcpSessionRuntime(this.workspace.id, sessionId, cwd, this.connection),
    );
    this.sessions.set(sessionId, registration);
    return runtimeId;
  }

  async unbindSession(sessionId: string): Promise<void> {
    const registration = this.sessions.get(sessionId);
    if (registration === undefined) return;
    this.sessions.delete(sessionId);
    await registration.remove();
  }

  async dispose(): Promise<void> {
    const registrations = [...this.sessions.values()];
    this.sessions.clear();
    for (const registration of registrations.reverse()) await registration.remove();
  }
}

export class AcpRuntimeProviderFactory implements RuntimeProviderFactory {
  readonly id = 'acp';
  readonly imports = { root: [], imports: [], local: [] };
  private readonly attachments = new Map<string, AcpWorkspaceRuntimeAttachment>();

  constructor(private readonly connection: IAcpConnection) {}

  static runtimeId(sessionId: string): string {
    return `acp:${sessionId}`;
  }

  async attach(workspace: RuntimeProviderContext, host: RuntimeProviderHost): Promise<RuntimeProviderAttachment> {
    const attachment = new AcpWorkspaceRuntimeAttachment(workspace, host, this.connection);
    this.attachments.set(workspace.id, attachment);
    return {
      dispose: async () => {
        if (this.attachments.get(workspace.id) !== attachment) return;
        this.attachments.delete(workspace.id);
        await attachment.dispose();
      },
    };
  }

  bindSession(workspaceId: string, sessionId: string, cwd: string): string {
    const attachment = this.attachments.get(workspaceId);
    if (attachment === undefined) throw new Error(`ACP runtime provider is not attached to workspace ${workspaceId}`);
    return attachment.bindSession(sessionId, cwd);
  }

  async unbindSession(workspaceId: string, sessionId: string): Promise<void> {
    await this.attachments.get(workspaceId)?.unbindSession(sessionId);
  }
}
