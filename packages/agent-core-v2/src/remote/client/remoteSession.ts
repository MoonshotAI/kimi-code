import { execFile } from 'node:child_process';

import type {
  HostEnvironmentInfo,
  PathClass,
  ShellName,
} from '#/os/interface/hostEnvironment';

import { ExecBridge, type ExecBridgeExit } from './execBridge';
import { RemoteFileSystem } from '#/os/backends/remote/remoteFileSystem';
import { RemoteProcessService } from '#/os/backends/remote/remoteProcess';

import { DEFAULT_INITIALIZE_TIMEOUT_MS, HandshakeError, RemoteExecConnection } from './connection';
import { DEFAULT_REMOTE_BIN, isBareRemoteBin, powerShellCommand, resolveLauncher, resolveSshCommand, type LauncherSpec } from './launchers';
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
      const sshEnv = askpass === undefined ? undefined : { ...process.env, ...askpass.env };
      const sshPlatform = options.launcher.type === 'ssh' && !isBareRemoteBin(options.launcher.remoteBin ?? DEFAULT_REMOTE_BIN)
        ? await detectSshPlatform(options.launcher.host, sshEnv, options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS)
        : 'posix';
      const resolved = resolveLauncher(options.launcher, options.sshAuth !== undefined, sshPlatform);
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

async function detectSshPlatform(
  host: string,
  env: NodeJS.ProcessEnv | undefined,
  timeoutMs: number,
): Promise<'posix' | 'windows'> {
  const probes = ['uname -s', powerShellCommand("[Console]::WriteLine('KIMI_WINDOWS')")];
  for (const [index, command] of probes.entries()) {
    const launcher = resolveSshCommand(host, command, env !== undefined);
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const child = execFile(launcher.program, [...launcher.args], {
        env,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
        encoding: 'utf8',
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error?.killed && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(new HandshakeError(`SSH platform probe timed out after ${timeoutMs}ms${stderr.trim() ? `: ${stderr.trim()}` : ''}`, { kind: 'timeout', cause: error }));
        } else if (error !== null && typeof error.code !== 'number') {
          reject(new HandshakeError(`SSH platform probe failed: ${error.message}`, { kind: 'executor-exit', cause: error }));
        } else {
          resolve({ stdout, stderr, code: typeof error?.code === 'number' ? error.code : 0 });
        }
      });
      child.stdin?.end();
    });
    const output = result.stdout.trim().split(/\r?\n/).at(-1);
    if (result.code === 255) {
      const authenticationFailed = /Permission denied \([^)]*(?:password|keyboard-interactive)[^)]*\)/i.test(result.stderr);
      throw new HandshakeError(`SSH platform probe failed: ${result.stderr.trim() || 'ssh exited with code 255'}`, {
        kind: authenticationFailed ? 'authentication' : 'executor-exit', exitCode: 255,
      });
    }
    if (result.code === 0 && output) {
      if (index === 0) return /^(?:MINGW|MSYS|CYGWIN)/i.test(output) ? 'windows' : 'posix';
      if (output === 'KIMI_WINDOWS') return 'windows';
    }
    if (index === probes.length - 1) {
      throw new HandshakeError(`Could not detect the SSH target platform: ${result.stderr.trim() || result.stdout.trim() || `probe exited with code ${result.code}`}`, {
        kind: 'executor-exit', exitCode: result.code,
      });
    }
  }
  throw new Error('SSH platform probes exhausted');
}
