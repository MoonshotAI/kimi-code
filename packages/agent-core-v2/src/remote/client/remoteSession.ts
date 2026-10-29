import type {
  HostEnvironmentInfo,
  PathClass,
  ShellName,
} from '#/os/interface/hostEnvironment';

import { ExecBridge, type ExecBridgeExit } from './execBridge';
import { RemoteFileSystem } from '#/os/backends/remote/remoteFileSystem';
import { RemoteProcessService } from '#/os/backends/remote/remoteProcess';

import { HandshakeError, RemoteExecConnection } from './connection';
import { resolveLauncher, type LauncherSpec } from './launchers';
import { createSshAskpass, type SshAuthOptions } from './sshAskpass';

export interface RemoteEnvironmentProbe extends HostEnvironmentInfo {
  readonly cwd: string;
  readonly tempDir: string;
}

export interface RemoteSessionOptions {
  readonly environmentId: string;
  readonly launcher: LauncherSpec;
  readonly clientVersion?: string;
  readonly minExecutorVersion?: string;
  readonly initializeTimeoutMs?: number;
  readonly sshAuth?: SshAuthOptions;
}

export class RemoteSession {
  readonly host: RemoteEnvironmentProbe;
  readonly fs: RemoteFileSystem;
  readonly process: RemoteProcessService;
  readonly executorVersion: string;
  private disposed = false;

  static async connect(options: RemoteSessionOptions): Promise<RemoteSession> {
    const askpass = options.sshAuth === undefined ? undefined : await createSshAskpass(options.sshAuth);
    try {
      const resolved = resolveLauncher(options.launcher, options.sshAuth !== undefined);
      const bridge = ExecBridge.spawn({
        program: resolved.program,
        args: resolved.args,
        env: askpass === undefined ? resolved.env : { ...process.env, ...resolved.env, ...askpass.env },
      });
      let exitInfo: ExecBridgeExit | undefined;
      const exitWatch = bridge.exited.then((exit: ExecBridgeExit) => {
        exitInfo = exit;
      });
      let connection: RemoteExecConnection;
      try {
        connection = await RemoteExecConnection.connect(bridge, {
          clientName: 'kimi-code',
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
          const authenticationFailed = options.launcher.type === 'ssh' && exit.code === 255 &&
            /Permission denied \([^)]*(?:password|keyboard-interactive)[^)]*\)/i.test(stderr);
          throw new HandshakeError(
            `executor process exited before the handshake completed (code ${exit.code ?? 'null'}, signal ${exit.signal ?? 'null'})${detail !== undefined && detail.length > 0 ? `: ${detail}` : ''}`,
            { kind: authenticationFailed ? 'authentication' : 'executor-exit', exitCode: exit.code, cause: error },
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
      return new RemoteSession(bridge, connection);
    } finally {
      await askpass?.close();
    }
  }

  private constructor(
    private readonly bridge: ExecBridge,
    readonly connection: RemoteExecConnection,
  ) {
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
    this.fs = new RemoteFileSystem(connection);
    this.process = new RemoteProcessService(connection, environment.cwd, environment.shellPath);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.connection.close();
    this.bridge.close();
    await this.bridge.exited.catch(() => {});
  }
}
