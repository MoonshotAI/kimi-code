import { randomUUID } from 'node:crypto';
import * as posixPath from 'node:path/posix';

import { Emitter } from '@moonshot-ai/agent-core-v2/_base/event';
import type {
  HostEnvironmentInfo,
  PathClass,
  ShellName,
} from '@moonshot-ai/agent-core-v2/os/interface/hostEnvironment';
import type {
  Runtime,
  RuntimeCapability,
  RuntimeIdentity,
  RuntimePath,
  RuntimeStatus,
} from '@moonshot-ai/agent-core-v2/runtime/runtime';

import { ExecBridge, type ExecBridgeExit } from './execBridge';
import { HandshakeError, RemoteExecConnection } from './connection';
import { resolveLauncher, type LauncherSpec } from './launchers';
import { RemoteFileSystem } from './remoteFileSystem';
import { RemoteProcessService } from './remoteProcess';
import { RemoteTerminalService } from './remoteTerminal';

export interface RemoteEnvironment extends HostEnvironmentInfo {
  readonly cwd: string;
  readonly tempDir: string;
}

export interface RemoteRuntimeOptions {
  readonly workspaceId: string;
  readonly runtimeId: string;
  readonly launcher: LauncherSpec;
  readonly generation?: string;
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly minExecutorVersion?: string;
  readonly initializeTimeoutMs?: number;
  readonly onDiagnostic?: (line: string) => void;
}

export class RemoteRuntime implements Runtime {
  readonly identity: RuntimeIdentity;
  readonly capabilities: ReadonlySet<RuntimeCapability>;
  readonly environment: RemoteEnvironment;
  readonly path: RuntimePath;
  readonly workspace: Runtime['workspace'];
  readonly fs: RemoteFileSystem;
  readonly process: RemoteProcessService;
  readonly terminal: RemoteTerminalService;
  readonly executorVersion: string;
  private currentStatus: RuntimeStatus = 'ready';
  private readonly statusEmitter = new Emitter<RuntimeStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;

  static async connect(options: RemoteRuntimeOptions): Promise<RemoteRuntime> {
    const resolved = resolveLauncher(options.launcher);
    const bridge = ExecBridge.spawn({
      program: resolved.program,
      args: resolved.args,
      env: resolved.env,
    });
    let exitInfo: ExecBridgeExit | undefined;
    const exitWatch = bridge.exited.then((exit: ExecBridgeExit) => {
      exitInfo = exit;
    });
    let connection: RemoteExecConnection;
    try {
      connection = await RemoteExecConnection.connect(bridge, {
        clientName: options.clientName ?? 'kimi-code',
        clientVersion: options.clientVersion ?? '0.0.0',
        minExecutorVersion: options.minExecutorVersion,
        initializeTimeoutMs: options.initializeTimeoutMs,
      });
    } catch (error) {
      bridge.close();
      const exit = await Promise.race([
        exitWatch.then(() => exitInfo),
        new Promise<undefined>((resolve) => {
          setTimeout(() => {
            resolve(undefined);
          }, 100);
        }),
      ]);
      if (exit !== undefined && !(error instanceof HandshakeError)) {
        const stderr = bridge.getStderrTail().trim();
        throw new HandshakeError(
          `executor process exited before the handshake completed (code ${exit.code ?? 'null'}, signal ${exit.signal ?? 'null'})${stderr.length > 0 ? `: ${stderr}` : ''}`,
        );
      }
      throw error;
    }
    return new RemoteRuntime(options, bridge, connection);
  }

  private constructor(
    options: RemoteRuntimeOptions,
    private readonly bridge: ExecBridge,
    readonly connection: RemoteExecConnection,
  ) {
    this.identity = {
      workspaceId: options.workspaceId,
      runtimeId: options.runtimeId,
      generation: options.generation ?? `${options.runtimeId}-${randomUUID()}`,
    };
    this.capabilities = new Set<RuntimeCapability>(['fs', 'process', 'terminal']);
    const environment = connection.environment;
    this.environment = {
      osKind: environment.osKind,
      osArch: environment.osArch,
      osVersion: environment.osVersion,
      shellName: environment.shellName as ShellName,
      shellPath: environment.shellPath,
      pathClass: environment.pathClass as PathClass,
      homeDir: environment.homeDir,
      cwd: environment.cwd,
      tempDir: environment.tempDir,
    };
    this.executorVersion = connection.executorVersion;
    this.path = {
      separator: '/',
      delimiter: ':',
      isAbsolute: (path) => posixPath.isAbsolute(path),
      join: (...paths) => posixPath.join(...paths),
      relative: (from, to) => posixPath.relative(from, to),
      resolve: (...paths) => posixPath.resolve(...paths),
      basename: (path) => posixPath.basename(path),
      dirname: (path) => posixPath.dirname(path),
    };
    this.workspace = {
      mapRoots: (roots) => ({
        workDir: posixPath.resolve(roots.workDir),
        additionalDirs: roots.additionalDirs?.map((root) => posixPath.resolve(root)),
      }),
    };
    this.fs = new RemoteFileSystem(connection);
    this.process = new RemoteProcessService(connection, environment.cwd, environment.shellPath);
    this.terminal = new RemoteTerminalService(connection, options.onDiagnostic);
    connection.onDidClose(() => {
      this.setStatus('disconnected');
    });
  }

  get status(): RuntimeStatus {
    return this.currentStatus;
  }

  private setStatus(status: RuntimeStatus): void {
    if (this.currentStatus === status || this.currentStatus === 'disposed') return;
    this.currentStatus = status;
    this.statusEmitter.fire(status);
  }

  async dispose(): Promise<void> {
    if (this.currentStatus === 'disposed') return;
    this.setStatus('disposed');
    this.connection.close();
    this.bridge.close();
    await this.bridge.exited.catch(() => {});
    this.statusEmitter.dispose();
  }
}
