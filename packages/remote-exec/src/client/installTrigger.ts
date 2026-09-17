import { MIN_EXECUTOR_VERSION } from '#/protocol/methods';

import type { ExecutorArtifactLocator } from './artifactLocator';
import { HandshakeError } from './connection';
import {
  ExecutorInstallError,
  installExecutor,
  launcherLabel,
  type ExecutorInstallResult,
  type LocalRunner,
} from './executorInstaller';
import type { LauncherSpec } from './launchers';

export type HandshakeFailureClass = 'missing' | 'timeout' | 'incompatible' | 'other';

// Classifies a failed connect for the auto-install trigger (spec D8): the
// remote shell reports a missing executor as exit 127, docker exec as 126
// ("executable file not found"), and a silent executor as a handshake
// timeout. Anything else (protocol violation, local spawn failure, refused
// non-posix target) is not installable.
export function classifyHandshakeFailure(error: unknown): HandshakeFailureClass {
  if (!(error instanceof HandshakeError)) return 'other';
  if (error.kind === 'executor-exit') {
    return error.exitCode === 127 || error.exitCode === 126 ? 'missing' : 'other';
  }
  if (error.kind === 'timeout') return 'timeout';
  if (error.kind === 'incompatible') return 'incompatible';
  return 'other';
}

function failureIntro(launcher: LauncherSpec, failure: HandshakeFailureClass): string {
  const label = launcherLabel(launcher);
  if (failure === 'timeout') {
    return `The remote executor on ${label} did not answer the handshake in time — it may be missing or unable to start.`;
  }
  return `The remote executor (kimi exec-server) was not found on ${label}.`;
}

function manualInstallGuidance(launcher: LauncherSpec): string {
  const lines = [
    'Install the executor manually:',
    '  1. download the `kimi` binary for the target platform from the Kimi Code release CDN',
    '     (`<cdnBase>/binaries/<version>/manifest.json` lists each platform filename and its pinned sha256),',
    '  2. copy it to the target and activate it atomically:',
  ];
  if (launcher.type === 'ssh') {
    const dest = launcher.remoteBin ?? '~/.kimi-code/bin/kimi';
    lines.push(
      `       scp <kimi-binary> ${launcher.host}:/tmp/kimi-install`,
      `       ssh ${launcher.host} 'chmod 755 /tmp/kimi-install && mkdir -p ~/.kimi-code/bin && mv -f /tmp/kimi-install ${dest}'`,
    );
  } else if (launcher.type === 'docker') {
    const context = launcher.context === undefined ? '' : `--context ${launcher.context} `;
    lines.push(
      `       docker ${context}cp <kimi-binary> ${launcher.container}:/tmp/kimi-install`,
      `       docker ${context}exec ${launcher.container} sh -c 'mkdir -p "$HOME"/.kimi-code/bin && chmod 755 /tmp/kimi-install && mv -f /tmp/kimi-install "$HOME"/.kimi-code/bin/kimi'`,
      '     (or preinstall the executor in the image / bind-mount it, and set remoteBin to that absolute path)',
    );
  } else {
    lines.push(
      '     place it at the absolute path your launcher command invokes, with execute permission',
    );
  }
  lines.push('Then reconnect the environment.');
  return lines.join('\n');
}

export interface MissingExecutorGuidanceContext {
  readonly launcher: LauncherSpec;
  readonly failure: HandshakeFailureClass;
  readonly reason: 'command-environment' | 'locator-unconfigured' | 'install-disabled' | 'install-failed';
  readonly installError?: unknown;
}

export function missingExecutorGuidance(context: MissingExecutorGuidanceContext): string {
  const parts = [failureIntro(context.launcher, context.failure)];
  switch (context.reason) {
    case 'command-environment':
      parts.push('Auto-install is not available for `command` environments.');
      break;
    case 'locator-unconfigured':
      parts.push('Auto-install is not configured in this client (no executor artifact locator).');
      break;
    case 'install-disabled':
      parts.push('Auto-install is disabled in this client.');
      break;
    case 'install-failed': {
      const detail =
        context.installError instanceof ExecutorInstallError
          ? `step "${context.installError.step}": ${context.installError.message}`
          : context.installError instanceof Error
            ? context.installError.message
            : String(context.installError);
      parts.push(`Auto-install failed (${detail}).`);
      const artifact =
        context.installError instanceof ExecutorInstallError ? context.installError.artifact : undefined;
      if (artifact !== undefined) {
        parts.push(`The verified artifact is ${artifact.url} (sha256 ${artifact.sha256}).`);
      }
      break;
    }
  }
  parts.push(manualInstallGuidance(context.launcher));
  return parts.join('\n');
}

// D9 upgrade guidance — deliberately distinct from the missing-executor
// guidance: the executor answered the handshake but is too old, so the fix is
// an upgrade, not an install.
export function upgradeExecutorGuidance(context: {
  readonly launcher: LauncherSpec;
  readonly executorVersion?: string;
  readonly minExecutorVersion?: string;
}): string {
  const label = launcherLabel(context.launcher);
  const found = context.executorVersion ?? 'unknown';
  const minimum = context.minExecutorVersion ?? MIN_EXECUTOR_VERSION;
  return (
    `The remote executor on ${label} reports version ${found}, below the required minimum ${minimum}. ` +
    'Upgrade the executor on the target and reconnect: install the current release binary into the ' +
    'executor path (`~/.kimi-code/bin/kimi` or the configured remoteBin), or rebuild the container ' +
    'image / bind-mount with the current executor preinstalled.\n' +
    manualInstallGuidance(context.launcher)
  );
}

// The install succeeded but the reconnect still failed — the executor is
// present on the target, so the guidance points at diagnosing the executor
// itself rather than at installing.
export function reconnectAfterInstallGuidance(context: {
  readonly launcher: LauncherSpec;
  readonly install: ExecutorInstallResult;
}): string {
  return (
    `The executor ${context.install.version} was installed at ${context.install.remoteBin} on ` +
    `${launcherLabel(context.launcher)}, but the reconnect still failed. The executor is present on ` +
    'the target — check why it does not answer the handshake (run it manually on the target and ' +
    'inspect its stderr), then reconnect the environment.'
  );
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

export interface ConnectWithAutoInstallOptions {
  readonly launcher: LauncherSpec;
  readonly artifactLocator?: ExecutorArtifactLocator;
  readonly autoInstall?: boolean;
  readonly clientVersion?: string;
  readonly minExecutorVersion?: string;
  readonly runner?: LocalRunner;
  readonly fetchImpl?: typeof fetch;
  readonly onDiagnostic?: (line: string) => void;
}

// Connect policy (spec D8/D9): a missing/timing-out executor on a typed
// ssh/docker environment triggers one auto-install attempt followed by exactly one
// connect retry; the retry uses the concrete install path (docker needs the
// absolute home-based path, its exec has no `~` expansion). `command`
// environments are never auto-installed — a missing executor there fails with
// guidance. A too-old executor gets upgrade guidance, not an auto-upgrade. A
// failed install or a failed retry both surface the guidance error.
export async function connectWithAutoInstall<T>(
  attempt: (launcher: LauncherSpec) => Promise<T>,
  options: ConnectWithAutoInstallOptions,
): Promise<T> {
  try {
    return await attempt(options.launcher);
  } catch (error) {
    const failure = classifyHandshakeFailure(error);
    if (failure === 'incompatible') {
      const handshake = error instanceof HandshakeError ? error : undefined;
      throw withGuidance(
        error,
        upgradeExecutorGuidance({
          launcher: options.launcher,
          executorVersion: handshake?.executorVersion,
          minExecutorVersion: handshake?.minExecutorVersion,
        }),
      );
    }
    if (failure !== 'missing' && failure !== 'timeout') {
      throw error;
    }
    const launcher = options.launcher;
    if (launcher.type === 'command') {
      throw withGuidance(
        error,
        missingExecutorGuidance({
          launcher,
          failure,
          reason: 'command-environment',
        }),
      );
    }
    if (options.autoInstall === false) {
      throw withGuidance(
        error,
        missingExecutorGuidance({
          launcher,
          failure,
          reason: 'install-disabled',
        }),
      );
    }
    if (options.artifactLocator === undefined) {
      throw withGuidance(
        error,
        missingExecutorGuidance({
          launcher,
          failure,
          reason: 'locator-unconfigured',
        }),
      );
    }
    let install: ExecutorInstallResult;
    try {
      install = await installExecutor({
        launcher,
        locator: options.artifactLocator,
        version: options.clientVersion ?? '0.0.0',
        minExecutorVersion: options.minExecutorVersion,
        runner: options.runner,
        fetchImpl: options.fetchImpl,
        onProgress: options.onDiagnostic,
      });
    } catch (installError) {
      throw withGuidance(
        error,
        missingExecutorGuidance({
          launcher,
          failure,
          reason: 'install-failed',
          installError,
        }),
      );
    }
    options.onDiagnostic?.(
      `executor ${install.version} ${install.alreadyInstalled ? 'found' : 'installed'} at ${install.remoteBin}; reconnecting...`,
    );
    const retryLauncher: LauncherSpec = { ...launcher, remoteBin: install.remoteBin };
    try {
      return await attempt(retryLauncher);
    } catch (retryError) {
      throw withGuidance(
        retryError,
        reconnectAfterInstallGuidance({ launcher: retryLauncher, install }),
      );
    }
  }
}
