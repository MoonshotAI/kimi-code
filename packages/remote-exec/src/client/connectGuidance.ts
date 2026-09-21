import { MIN_EXECUTOR_VERSION } from '#/protocol/methods';

import { HandshakeError } from './connection';
import {
  defaultLocalRunner,
  launcherLabel,
  resolveTildeRemoteBin,
  type LocalRunner,
} from './executorDetect';
import { DEFAULT_REMOTE_BIN, type LauncherSpec } from './launchers';

export type HandshakeFailureClass = 'missing' | 'timeout' | 'incompatible' | 'other';

// Classifies a failed connect for the guidance policy: the remote shell
// reports a missing executor as exit 127, docker exec as 126 ("executable
// file not found"), and a silent executor as a handshake timeout. Anything
// else (protocol violation, local spawn failure, refused non-posix target)
// surfaces unchanged.
export function classifyHandshakeFailure(error: unknown): HandshakeFailureClass {
  if (!(error instanceof HandshakeError)) return 'other';
  if (error.kind === 'executor-exit') {
    return error.exitCode === 127 || error.exitCode === 126 ? 'missing' : 'other';
  }
  if (error.kind === 'timeout') return 'timeout';
  if (error.kind === 'incompatible') return 'incompatible';
  return 'other';
}

function expectedPathSuffix(launcher: LauncherSpec): string {
  if (launcher.type === 'command') return '';
  return ` (expected at ${launcher.remoteBin ?? DEFAULT_REMOTE_BIN})`;
}

function executorAction(launcher: LauncherSpec): string {
  const location =
    launcher.type === 'command'
      ? 'the absolute path your launcher command invokes'
      : `the executor path (${launcher.remoteBin ?? DEFAULT_REMOTE_BIN})`;
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
  readonly runner?: LocalRunner;
}

// Connect policy: a docker launcher with a tilde-prefixed remoteBin is first
// resolved to the container user's absolute home path (docker exec has no
// shell expansion), so a missing-executor classification below means the
// executor is genuinely absent at the resolved path. The executor is never
// installed automatically: a missing/timing-out executor fails the connect
// with install guidance, and a too-old executor fails with upgrade guidance
// (current vs minimum version).
export async function connectWithGuidance<T>(
  attempt: (launcher: LauncherSpec) => Promise<T>,
  options: ConnectWithGuidanceOptions,
): Promise<T> {
  const launcher = await resolveTildeRemoteBin(options.launcher, options.runner ?? defaultLocalRunner);
  try {
    return await attempt(launcher);
  } catch (error) {
    const failure = classifyHandshakeFailure(error);
    if (failure === 'other') throw error;
    if (failure === 'incompatible') {
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
    throw withGuidance(error, missingExecutorGuidance(launcher, failure));
  }
}
