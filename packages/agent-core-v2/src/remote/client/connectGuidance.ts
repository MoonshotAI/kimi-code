import type { EnvironmentConnectFailure } from '#/environment/environment';
import { MIN_EXECUTOR_VERSION } from '#/remote/protocol/methods';

import { HandshakeError } from './connection';
import { isBareRemoteBin, launcherRemoteBin, type LauncherSpec } from './launchers';

export type TransportSource = 'ssh' | 'docker' | 'command';
export type HandshakeFailureClass = 'missing' | 'timeout' | 'incompatible' | 'other';

const WINDOWS_COMMAND_NOT_FOUND = /not recognized as an internal or external command|command not found/i;

function launcherLabel(launcher: LauncherSpec): string {
  switch (launcher.type) {
    case 'ssh':
      return `ssh:${launcher.host}`;
    case 'docker':
      return `docker:${launcher.container}`;
    case 'command':
      return `command:${launcher.program}`;
  }
}

export function classifyHandshakeFailure(error: unknown): HandshakeFailureClass {
  if (!(error instanceof HandshakeError)) return 'other';
  if (error.kind === 'executor-exit') {
    const missingStatus = error.exitCode === 127 || error.exitCode === 126 || error.exitCode === 9009;
    const windowsSshMissing = error.exitCode === 49 && WINDOWS_COMMAND_NOT_FOUND.test(error.message);
    return missingStatus || windowsSshMissing ? 'missing' : 'other';
  }
  if (error.kind === 'timeout' || error.kind === 'transport-timeout') return 'timeout';
  if (error.kind === 'incompatible') return 'incompatible';
  return 'other';
}

const LAUNCHER_NOT_FOUND = /launcher command "[^"]*" (?:is not an executable file|was not found on PATH)/;
const EXECUTOR_NOT_FOUND = /failed to find target executable|executable file not found|command not found|: not found\b/i;

const SSH_FAILURES: readonly (readonly [RegExp, EnvironmentConnectFailure])[] = [
  [/Could not resolve hostname|Name or service not known|nodename nor servname provided|No address associated with hostname|Temporary failure in name resolution/i, 'host_not_found'],
  [/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i, 'host_key_changed'],
  [/Permission denied \(|Too many authentication failures|no such identity/i, 'authentication_failed'],
  [/Connection refused/i, 'connection_refused'],
  [/No route to host|Network is unreachable|Host is down/i, 'host_unreachable'],
  [/Connection timed out|Operation timed out/i, 'connect_timeout'],
];

const DOCKER_FAILURES: readonly (readonly [RegExp, EnvironmentConnectFailure])[] = [
  [/Cannot connect to the Docker daemon|docker daemon is not running|error during connect/i, 'docker_unavailable'],
  [/No such container|container \S+ not found/i, 'container_not_found'],
  [/container \S+ is (?:not running|paused|restarting)/i, 'container_not_running'],
  [/Connection refused/i, 'connection_refused'],
  [/No route to host|Network is unreachable|Host is down/i, 'host_unreachable'],
  [/Connection timed out|Operation timed out/i, 'connect_timeout'],
];

export function classifyTransportStderr(stderr: string, source: TransportSource): EnvironmentConnectFailure | undefined {
  const tables = source === 'ssh' ? [SSH_FAILURES] : source === 'docker' ? [DOCKER_FAILURES] : [SSH_FAILURES, DOCKER_FAILURES];
  for (const table of tables) {
    const matched = table.find(([pattern]) => pattern.test(stderr));
    if (matched !== undefined) return matched[1];
  }
  return undefined;
}

export function passwordAuthenticationFailed(stderr: string): boolean {
  return /Permission denied \([^)]*(?:password|keyboard-interactive)[^)]*\)/i.test(stderr);
}

export function classifyConnectFailure(error: unknown, source?: TransportSource): EnvironmentConnectFailure {
  if (error instanceof HandshakeError && error.failure !== undefined) return error.failure;
  if (error instanceof HandshakeError && error.kind === 'incompatible') return 'executor_outdated';
  if (error instanceof HandshakeError && error.kind === 'transport-timeout') return 'connect_timeout';
  if (error instanceof HandshakeError && error.kind === 'authentication') return 'authentication_failed';
  const message = error instanceof Error ? error.message : String(error);
  if (LAUNCHER_NOT_FOUND.test(message)) return 'launcher_not_found';
  const transport = source === undefined ? undefined : classifyTransportStderr(message, source);
  if (transport !== undefined) return transport;
  if (!(error instanceof HandshakeError)) return 'unknown';
  if (error.exitCode === 49 && WINDOWS_COMMAND_NOT_FOUND.test(message)) return 'executor_not_found';
  if (EXECUTOR_NOT_FOUND.test(message)) return 'executor_not_found';
  const failure = classifyHandshakeFailure(error);
  if (failure === 'missing') return 'executor_not_found';
  if (failure === 'timeout') return 'executor_timeout';
  return 'unknown';
}

function expectedPathSuffix(launcher: LauncherSpec): string {
  const remoteBin = launcherRemoteBin(launcher);
  return remoteBin === undefined ? '' : ` (expected at ${remoteBin})`;
}

function executorAction(launcher: LauncherSpec): string {
  const remoteBin = launcherRemoteBin(launcher);
  if (remoteBin !== undefined && isBareRemoteBin(remoteBin)) {
    return `download the \`kimi\` binary for the target platform from the Kimi Code release CDN and install it as \`${remoteBin}\` on the target's PATH`;
  }
  const location =
    remoteBin === undefined
      ? 'the absolute path your launcher command invokes'
      : `the executor path (${remoteBin})`;
  return `download the \`kimi\` binary for the target platform from the Kimi Code release CDN and install it at ${location}`;
}

function missingExecutorGuidance(launcher: LauncherSpec, failure: 'missing' | 'timeout'): string {
  const label = launcherLabel(launcher);
  const intro =
    failure === 'timeout'
      ? `The remote executor on ${label} did not answer the handshake in time — it may be missing or unable to start${expectedPathSuffix(launcher)}.`
      : `The remote executor (kimi exec-server) was not found on ${label}${expectedPathSuffix(launcher)}.`;
  return `${intro}\n\nInstall the executor manually: ${executorAction(launcher)}.\n\nThen reconnect the environment.`;
}

function upgradeExecutorGuidance(
  launcher: LauncherSpec,
  executorVersion: string | undefined,
  minExecutorVersion: string | undefined,
): string {
  const found = executorVersion ?? 'unknown';
  const minimum = minExecutorVersion ?? MIN_EXECUTOR_VERSION;
  return `The remote executor on ${launcherLabel(launcher)} reports version ${found}, below the required minimum ${minimum}.\n\nUpgrade the executor on the target: ${executorAction(launcher)}.\n\nThen reconnect the environment.`;
}

function withGuidance(error: unknown, guidance: string): HandshakeError {
  const base =
    error instanceof Error
      ? error
      : new HandshakeError(typeof error === 'string' ? error : 'remote environment connect failed');
  const details =
    error instanceof HandshakeError
      ? {
          kind: error.kind,
          failure: error.failure,
          exitCode: error.exitCode,
          executorVersion: error.executorVersion,
          minExecutorVersion: error.minExecutorVersion,
        }
      : {};
  return new HandshakeError(`${base.message}\n\n${guidance}`, { ...details, cause: error });
}

export interface ConnectWithGuidanceOptions {
  readonly launcher: LauncherSpec;
  readonly minExecutorVersion?: string;
}

export async function connectWithGuidance<T>(
  attempt: (launcher: LauncherSpec) => Promise<T>,
  options: ConnectWithGuidanceOptions,
): Promise<T> {
  const launcher = options.launcher;
  try {
    return await attempt(launcher);
  } catch (error) {
    const failure = classifyConnectFailure(error, launcher.type);
    if (failure === 'executor_outdated') {
      const handshake = error instanceof HandshakeError ? error : undefined;
      throw withGuidance(
        error,
        upgradeExecutorGuidance(
          launcher,
          handshake?.executorVersion,
          handshake?.minExecutorVersion ?? options.minExecutorVersion,
        ),
      );
    }
    if (failure === 'executor_not_found') throw withGuidance(error, missingExecutorGuidance(launcher, 'missing'));
    if (failure === 'executor_timeout') throw withGuidance(error, missingExecutorGuidance(launcher, 'timeout'));
    throw error;
  }
}
