import { randomUUID } from 'node:crypto';
import * as posixPath from 'node:path/posix';

import { Emitter } from '#/_base/event';
import type {
  HostEnvironmentInfo,
  PathClass,
  ShellName,
} from '#/os/interface/hostEnvironment';
import type {
  Environment,
  EnvironmentCapability,
  EnvironmentIdentity,
  EnvironmentPath,
  EnvironmentStatus,
} from '#/environment/environment';

import { ExecBridge, type ExecBridgeExit } from './execBridge';
import { HandshakeError, RemoteExecConnection } from './connection';
import { resolveLauncher, type LauncherSpec } from './launchers';
import { RemoteFileSystem } from './remoteFileSystem';
import { RemoteProcessService } from './remoteProcess';

export interface RemoteEnvironmentProbe extends HostEnvironmentInfo {
  readonly cwd: string;
  readonly tempDir: string;
}

export interface RemoteEnvironmentOptions {
  readonly workspaceId: string;
  readonly environmentId: string;
  readonly launcher: LauncherSpec;
  readonly generation?: string;
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly minExecutorVersion?: string;
  readonly initializeTimeoutMs?: number;
}

export class RemoteEnvironment implements Environment {
  readonly identity: EnvironmentIdentity;
  readonly capabilities: ReadonlySet<EnvironmentCapability>;
  readonly host: RemoteEnvironmentProbe;
  readonly path: EnvironmentPath;
  readonly workspace: Environment['workspace'];
  readonly fs: RemoteFileSystem;
  readonly process: RemoteProcessService;
  readonly executorVersion: string;
  private currentStatus: EnvironmentStatus = 'ready';
  private readonly statusEmitter = new Emitter<EnvironmentStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;

  static async connect(options: RemoteEnvironmentOptions): Promise<RemoteEnvironment> {
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
        const detail = stderr.length > 0 ? stderr : exit.error?.message;
        throw new HandshakeError(
          `executor process exited before the handshake completed (code ${exit.code ?? 'null'}, signal ${exit.signal ?? 'null'})${detail !== undefined && detail.length > 0 ? `: ${detail}` : ''}`,
          { kind: 'executor-exit', exitCode: exit.code, cause: error },
        );
      }
      if (error instanceof HandshakeError && error.kind === 'timeout') {
        const stderr = bridge.getStderrTail().trim();
        if (stderr.length > 0) {
          throw new HandshakeError(`${error.message}; executor stderr: ${stderr}`, {
            kind: 'timeout',
            cause: error,
          });
        }
      }
      throw error;
    }
    return new RemoteEnvironment(options, bridge, connection);
  }

  private constructor(
    options: RemoteEnvironmentOptions,
    private readonly bridge: ExecBridge,
    readonly connection: RemoteExecConnection,
  ) {
    this.identity = {
      workspaceId: options.workspaceId,
      environmentId: options.environmentId,
      generation: options.generation ?? `${options.environmentId}-${randomUUID()}`,
    };
    this.capabilities = new Set<EnvironmentCapability>(['fs', 'process']);
    const environment = connection.environment;
    this.host = {
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
    connection.onDidClose(() => {
      this.setStatus('disconnected');
    });
  }

  get status(): EnvironmentStatus {
    return this.currentStatus;
  }

  private setStatus(status: EnvironmentStatus): void {
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
