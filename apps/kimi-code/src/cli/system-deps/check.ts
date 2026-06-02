/**
 * System-dependency evaluation.
 *
 * `evaluateDependencies` is a pure function of an injected {@link DependencyProbe}
 * so the resolution/warning logic can be unit-tested without spawning processes.
 * `isRipgrepOnSystemPath` is the only side-effecting helper; the shell and fd
 * facts are gathered by the caller (shell from `harness.getEnvironment()`, fd
 * from the TUI's existing `detectFdPath()` result) so we never re-probe.
 */

import { spawnSync } from 'node:child_process';

import type { Environment } from '@moonshot-ai/kimi-code-sdk';

import { SYSTEM_DEPENDENCIES, type DependencyId, type SystemDependency } from './registry';

/** Raw, already-gathered facts about the current environment. */
export interface DependencyProbe {
  readonly environment: Environment;
  /** Result of the TUI's `detectFdPath()` (reused, not re-probed). */
  readonly fdAvailable: boolean;
  /** Whether `rg` resolves on the system PATH right now. */
  readonly rgOnSystemPath: boolean;
  /** Whether this platform/arch is one the ripgrep bootstrapper can download for. */
  readonly rgBootstrappable: boolean;
  /** Whether the working directory is a git repository (fd fallback scope). */
  readonly isGitRepo: boolean;
}

export interface DependencyStatus {
  readonly dependency: SystemDependency;
  readonly available: boolean;
  /** One-line, user-facing detail (resolved source, or why/how to fix). */
  readonly detail: string;
  /** Whether this missing dependency warrants a startup warning right now. */
  readonly shouldWarnAtStartup: boolean;
}

/** Probe whether `rg` is resolvable on the system PATH (cheap, ~ms). */
export function isRipgrepOnSystemPath(): boolean {
  try {
    return spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Whether the ripgrep bootstrapper can download a prebuilt binary for this
 * host. Mirrors `rg-locator`'s `detectTarget()` support matrix (darwin / linux
 * / win32 on x64 / arm64); on anything else the auto-download throws, so a
 * missing system `rg` is genuinely unavailable rather than self-healing.
 * Keep in sync with packages/agent-core/src/tools/support/rg-locator.ts.
 */
export function isRipgrepBootstrapSupported(): boolean {
  const platformOk =
    process.platform === 'darwin' ||
    process.platform === 'linux' ||
    process.platform === 'win32';
  const archOk = process.arch === 'x64' || process.arch === 'arm64';
  return platformOk && archOk;
}

/**
 * `available` means "the capability this dependency provides is currently
 * satisfied" — directly, by auto-bootstrap, or by a fallback — NOT merely
 * "the binary is on PATH". Kept uniform across dependencies so the `/status`
 * marker never contradicts its own detail text.
 */
function isAvailable(id: DependencyId, probe: DependencyProbe): boolean {
  switch (id) {
    case 'ripgrep':
      // On PATH now, or auto-downloadable on this platform — otherwise the
      // first Grep call will fail, so it is genuinely unavailable.
      return probe.rgOnSystemPath || probe.rgBootstrappable;
    case 'fd':
      // The binary, or the `git ls-files` fallback inside a git repository.
      return probe.fdAvailable || probe.isGitRepo;
    case 'shell':
      return probe.environment.shellAvailable !== false;
  }
}

function detailFor(
  dep: SystemDependency,
  available: boolean,
  probe: DependencyProbe,
): string {
  switch (dep.id) {
    case 'ripgrep':
      if (probe.rgOnSystemPath) return 'Found on system PATH.';
      return probe.rgBootstrappable
        ? 'Not on PATH — downloaded and cached on first use.'
        : `Not on PATH and no prebuilt binary for this platform. ${dep.fixHint}`;
    case 'fd':
      if (probe.fdAvailable) return 'Found on system PATH.';
      return probe.isGitRepo
        ? 'Not installed; using the `git ls-files` fallback in this git repository.'
        : `Missing and not in a git repository. ${dep.fixHint}`;
    case 'shell':
      if (available) return `Using ${probe.environment.shellPath}.`;
      return probe.environment.shellUnavailableReason ?? dep.fixHint;
  }
}

function shouldWarn(dep: SystemDependency, available: boolean, probe: DependencyProbe): boolean {
  if (available) return false;
  switch (dep.startupWarning) {
    case 'always':
      return true;
    case 'outside-git-repo':
      return !probe.isGitRepo;
    case 'never':
      return false;
  }
}

/** Pure evaluation of every registered dependency against the probe. */
export function evaluateDependencies(probe: DependencyProbe): DependencyStatus[] {
  return SYSTEM_DEPENDENCIES.map((dependency) => {
    const available = isAvailable(dependency.id, probe);
    return {
      dependency,
      available,
      detail: detailFor(dependency, available, probe),
      shouldWarnAtStartup: shouldWarn(dependency, available, probe),
    };
  });
}
