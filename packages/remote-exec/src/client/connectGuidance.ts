import { dirname as posixDirname } from 'node:path/posix';

import { MIN_EXECUTOR_VERSION } from '#/protocol/methods';

import {
  CdnExecutorArtifactLocator,
  type ExecutorArtifact,
  type ExecutorArtifactLocator,
} from './artifactLocator';
import { HandshakeError } from './connection';
import {
  defaultLocalRunner,
  launcherLabel,
  probeExecutorTarget,
  resolveTildeRemoteBin,
  shQuote,
  type LocalRunner,
} from './executorDetect';
import { DEFAULT_REMOTE_BIN, type LauncherSpec } from './launchers';

export type HandshakeFailureClass = 'missing' | 'timeout' | 'incompatible' | 'other';

// Classifies a failed connect for the guidance policy (spec D8): the remote
// shell reports a missing executor as exit 127, docker exec as 126
// ("executable file not found"), and a silent executor as a handshake
// timeout. Anything else (protocol violation, local spawn failure, refused
// non-posix target) surfaces unchanged.
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

function failureIntro(launcher: LauncherSpec, failure: 'missing' | 'timeout'): string {
  const label = launcherLabel(launcher);
  if (failure === 'timeout') {
    return `The remote executor on ${label} did not answer the handshake in time — it may be missing or unable to start${expectedPathSuffix(launcher)}.`;
  }
  return `The remote executor (kimi exec-server) was not found on ${label}${expectedPathSuffix(launcher)}.`;
}

function dockerCommand(launcher: LauncherSpec & { readonly type: 'docker' }): string {
  if (launcher.context === undefined) return 'docker';
  return `docker --context ${shQuote(launcher.context)}`;
}

// A tilde-prefixed remoteBin reaches the printed commands as text — neither
// the sh -c wrapper nor scp expands `~` inside quotes. Prefer the probed
// remote $HOME for a literal absolute path; without it, spell the prefix
// through "$HOME", which the remote shell expands at runtime (docker
// resolves its default to the probed container home before the first
// attempt, so it usually arrives here already absolute).
function guidanceDest(remoteBin: string | undefined, homeDir: string | undefined): string {
  const dest = remoteBin ?? DEFAULT_REMOTE_BIN;
  if (dest !== '~' && !dest.startsWith('~/')) return dest;
  if (homeDir !== undefined) return `${homeDir === '/' ? '' : homeDir}${dest.slice(1)}`;
  return `$HOME${dest.slice(1)}`;
}

// The remote command that moves an uploaded /tmp/kimi-install into place.
// Single-quoted as one argument at the call site (ssh joins argv, docker exec
// runs `sh -c`), so paths inside use double quotes.
function remoteActivateScript(
  launcher: LauncherSpec & { readonly type: 'ssh' | 'docker' },
  homeDir?: string,
): string {
  const dest = guidanceDest(launcher.remoteBin, homeDir);
  return `mkdir -p "${posixDirname(dest)}" && chmod 755 /tmp/kimi-install && mv -f /tmp/kimi-install "${dest}"`;
}

// The verify step keeps the auto-installer's pinned-hash discipline in the
// manual flow: the download is checked against the manifest's sha256 before
// the binary leaves for the target. The commands run on the user's machine,
// so the tool follows the local platform (sha256sum on Linux, shasum on
// macOS).
function verifyDownloadLine(sha256: string): string {
  const tool = process.platform === 'darwin' ? 'shasum -a 256' : 'sha256sum';
  return `  echo "${sha256}  /tmp/kimi-install" | ${tool} -c -`;
}

function downloadAndActivateLines(
  launcher: LauncherSpec & { readonly type: 'ssh' | 'docker' },
  artifact: ExecutorArtifact,
  homeDir?: string,
): string[] {
  if (launcher.type === 'ssh') {
    return [
      `  curl -fL ${artifact.url} -o /tmp/kimi-install`,
      verifyDownloadLine(artifact.sha256),
      `  scp /tmp/kimi-install ${launcher.host}:/tmp/kimi-install`,
      `  ssh ${launcher.host} '${remoteActivateScript(launcher, homeDir)}'`,
    ];
  }
  const docker = dockerCommand(launcher);
  return [
    `  curl -fL ${artifact.url} -o /tmp/kimi-install`,
    verifyDownloadLine(artifact.sha256),
    `  ${docker} cp /tmp/kimi-install ${launcher.container}:/tmp/kimi-install`,
    `  ${docker} exec ${launcher.container} sh -c '${remoteActivateScript(launcher, homeDir)}'`,
    '  (or preinstall the executor in the image / bind-mount it, and set remoteBin to that absolute path)',
  ];
}

function concreteGuidanceBlock(
  launcher: LauncherSpec & { readonly type: 'ssh' | 'docker' },
  artifact: ExecutorArtifact,
  kind: 'missing' | 'upgrade',
  homeDir?: string,
): string {
  const header =
    kind === 'missing'
      ? `Install the executor (version ${artifact.version}, sha256 ${artifact.sha256}):`
      : `Upgrade the executor (install version ${artifact.version}, sha256 ${artifact.sha256}):`;
  return [header, ...downloadAndActivateLines(launcher, artifact, homeDir)].join('\n');
}

function releaseManifestHint(
  locator: ExecutorArtifactLocator | undefined,
  version: string | undefined,
): string {
  if (locator instanceof CdnExecutorArtifactLocator && version !== undefined) {
    return `\`${locator.manifestUrl(version)}\``;
  }
  return '`<cdnBase>/binaries/<version>/manifest.json`';
}

function commandInstallBlock(manifestHint: string): string {
  return (
    'Install the executor manually: download the `kimi` binary for the target platform from the ' +
    `Kimi Code release CDN (${manifestHint} lists each platform filename and its pinned sha256), ` +
    'place it at the absolute path your launcher command invokes, and give it execute permission.'
  );
}

function genericInstallBlock(
  launcher: LauncherSpec & { readonly type: 'ssh' | 'docker' },
  manifestHint: string,
): string {
  const activate = remoteActivateScript(launcher);
  const lines = [
    'Install the executor manually:',
    '  1. download the `kimi` binary for the target platform from the Kimi Code release CDN',
    `     (${manifestHint} lists each platform filename and its pinned sha256),`,
    '  2. copy it to the target and activate it:',
  ];
  if (launcher.type === 'ssh') {
    lines.push(
      `       scp <kimi-binary> ${launcher.host}:/tmp/kimi-install`,
      `       ssh ${launcher.host} '${activate}'`,
    );
  } else {
    const docker = dockerCommand(launcher);
    lines.push(
      `       ${docker} cp <kimi-binary> ${launcher.container}:/tmp/kimi-install`,
      `       ${docker} exec ${launcher.container} sh -c '${activate}'`,
      '     (or preinstall the executor in the image / bind-mount it, and set remoteBin to that absolute path)',
    );
  }
  return lines.join('\n');
}

function genericUpgradeBlock(launcher: LauncherSpec, manifestHint: string): string {
  if (launcher.type === 'command') {
    return (
      'Upgrade the executor on the target: download the current `kimi` binary for the target ' +
      `platform from the Kimi Code release CDN (${manifestHint} lists each platform filename and ` +
      'its pinned sha256) and install it at the absolute path your launcher command invokes.'
    );
  }
  return (
    'Upgrade the executor on the target: download the current `kimi` binary for the target ' +
    `platform from the Kimi Code release CDN (${manifestHint} lists each platform filename and ` +
    `its pinned sha256) and install it over the executor path (${launcher.remoteBin ?? DEFAULT_REMOTE_BIN}); ` +
    'for a container, rebuilding the image or bind-mounting the current executor also works.'
  );
}

export interface MissingExecutorGuidanceContext {
  readonly launcher: LauncherSpec;
  readonly failure: 'missing' | 'timeout';
  // The release artifact located for the probed target platform. Present only
  // when a locator and client version are configured and the probe succeeded —
  // the guidance then names a concrete, directly runnable download.
  readonly artifact?: ExecutorArtifact;
  // The probed remote home; tilde-prefixed remoteBin values in the printed
  // commands resolve against it.
  readonly homeDir?: string;
  readonly artifactLocator?: ExecutorArtifactLocator;
  readonly clientVersion?: string;
}

export function missingExecutorGuidance(context: MissingExecutorGuidanceContext): string {
  const parts = [failureIntro(context.launcher, context.failure)];
  const launcher = context.launcher;
  if (launcher.type === 'command') {
    parts.push(commandInstallBlock(releaseManifestHint(context.artifactLocator, context.clientVersion)));
  } else if (context.artifact !== undefined) {
    parts.push(concreteGuidanceBlock(launcher, context.artifact, 'missing', context.homeDir));
  } else {
    parts.push(genericInstallBlock(launcher, releaseManifestHint(context.artifactLocator, context.clientVersion)));
  }
  parts.push('Then reconnect the environment.');
  return parts.join('\n\n');
}

export interface UpgradeExecutorGuidanceContext {
  readonly launcher: LauncherSpec;
  readonly executorVersion?: string;
  readonly minExecutorVersion?: string;
  readonly artifact?: ExecutorArtifact;
  readonly homeDir?: string;
  readonly artifactLocator?: ExecutorArtifactLocator;
  readonly clientVersion?: string;
}

// D9 upgrade guidance — deliberately distinct from the missing-executor
// guidance: the executor answered the handshake but is too old, so the fix is
// an upgrade, not an install.
export function upgradeExecutorGuidance(context: UpgradeExecutorGuidanceContext): string {
  const found = context.executorVersion ?? 'unknown';
  const minimum = context.minExecutorVersion ?? MIN_EXECUTOR_VERSION;
  const parts = [
    `The remote executor on ${launcherLabel(context.launcher)} reports version ${found}, below the required minimum ${minimum}.`,
  ];
  const launcher = context.launcher;
  if (launcher.type !== 'command' && context.artifact !== undefined) {
    parts.push(concreteGuidanceBlock(launcher, context.artifact, 'upgrade', context.homeDir));
  } else {
    parts.push(
      genericUpgradeBlock(launcher, releaseManifestHint(context.artifactLocator, context.clientVersion)),
    );
  }
  parts.push('Then reconnect the environment.');
  return parts.join('\n\n');
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
  readonly artifactLocator?: ExecutorArtifactLocator;
  readonly clientVersion?: string;
  readonly minExecutorVersion?: string;
  readonly runner?: LocalRunner;
  /** Maximum time spent enriching a failed handshake with diagnostics. */
  readonly diagnosticTimeoutMs?: number;
}

export const DEFAULT_DIAGNOSTIC_TIMEOUT_MS = 2_000;

class DiagnosticTimeoutError extends Error {
  constructor() {
    super('remote executor diagnostics timed out');
    this.name = 'DiagnosticTimeoutError';
  }
}

function diagnosticBudgetMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DIAGNOSTIC_TIMEOUT_MS;
  if (!Number.isFinite(value) || value < 0) return DEFAULT_DIAGNOSTIC_TIMEOUT_MS;
  return value;
}

async function withinDiagnosticBudget<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new DiagnosticTimeoutError();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DiagnosticTimeoutError()), remaining);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// The failure guidance can name a concrete download only when the target
// platform is known: typed ssh/docker launchers still run one remote command
// after a missing/too-old executor failure, so probe `uname` and locate the
// release artifact for it. `command` launchers have no probe channel, and any
// probe/locate failure degrades to the generic release-CDN wording — guidance
// generation never masks the original handshake failure.
async function locateGuidanceArtifact(
  launcher: LauncherSpec,
  options: ConnectWithGuidanceOptions,
  runner: LocalRunner,
  deadline: number,
): Promise<{ readonly artifact: ExecutorArtifact; readonly homeDir?: string } | undefined> {
  if (launcher.type === 'command') return undefined;
  if (options.artifactLocator === undefined || options.clientVersion === undefined) return undefined;
  const boundedRunner: LocalRunner = (request) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.reject(new DiagnosticTimeoutError());
    return runner({
      ...request,
      timeoutMs: request.timeoutMs === undefined ? remaining : Math.min(request.timeoutMs, remaining),
    });
  };
  const probed = await withinDiagnosticBudget(probeExecutorTarget(launcher, boundedRunner), deadline);
  if (probed === undefined) return undefined;
  const artifact = await withinDiagnosticBudget(
    options.artifactLocator.locate(probed.target, options.clientVersion),
    deadline,
  ).catch(() => undefined);
  if (artifact === undefined) return undefined;
  return { artifact, homeDir: probed.homeDir };
}

// Connect policy (spec D8/D9): a docker launcher with a tilde-prefixed
// remoteBin is first resolved to the container user's absolute home path
// (docker exec has no shell expansion), so a missing-executor classification
// below means the executor is genuinely absent at the resolved path. The
// executor is never installed automatically: a missing/timing-out executor
// fails the connect with per-launcher install guidance, and a too-old
// executor fails with upgrade guidance (current vs minimum version).
export async function connectWithGuidance<T>(
  attempt: (launcher: LauncherSpec) => Promise<T>,
  options: ConnectWithGuidanceOptions,
): Promise<T> {
  const runner = options.runner ?? defaultLocalRunner;
  const launcher = await resolveTildeRemoteBin(options.launcher, runner);
  try {
    return await attempt(launcher);
  } catch (error) {
    const failure = classifyHandshakeFailure(error);
    if (failure === 'other') throw error;
    const deadline = Date.now() + diagnosticBudgetMs(options.diagnosticTimeoutMs);
    let located: { readonly artifact: ExecutorArtifact; readonly homeDir?: string } | undefined;
    try {
      located = await locateGuidanceArtifact(launcher, options, runner, deadline);
    } catch {
      located = undefined;
    }
    if (failure === 'incompatible') {
      const handshake = error instanceof HandshakeError ? error : undefined;
      throw withGuidance(
        error,
        upgradeExecutorGuidance({
          launcher,
          executorVersion: handshake?.executorVersion,
          minExecutorVersion: handshake?.minExecutorVersion ?? options.minExecutorVersion,
          artifact: located?.artifact,
          homeDir: located?.homeDir,
          artifactLocator: options.artifactLocator,
          clientVersion: options.clientVersion,
        }),
      );
    }
    throw withGuidance(
      error,
      missingExecutorGuidance({
        launcher,
        failure,
        artifact: located?.artifact,
        homeDir: located?.homeDir,
        artifactLocator: options.artifactLocator,
        clientVersion: options.clientVersion,
      }),
    );
  }
}
