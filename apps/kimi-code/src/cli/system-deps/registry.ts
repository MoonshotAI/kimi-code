/**
 * System-dependency registry — the single source of truth for the external
 * command-line tools Kimi Code CLI relies on (`rg`, `fd`, and a POSIX shell).
 *
 * Historically each dependency was probed, degraded, and described in its own
 * corner of the codebase (ripgrep in `rg-locator`, fd in `fd-detect`, the
 * shell in KAOS environment detection). That made "is X a dependency, and what
 * happens when it is missing?" impossible to answer in one place. This module
 * declares each dependency once — its purpose, whether it is required, whether
 * the CLI can self-heal by downloading it, its graceful-degradation path, and
 * when its absence should warn the user. `check.ts` and `report.ts` read from
 * here so detection and messaging stay consistent and new dependencies are a
 * one-line addition.
 */

export type DependencyId = 'ripgrep' | 'fd' | 'shell';

export type DependencyRequirement = 'required' | 'optional';

/**
 * When a missing dependency should surface a startup warning:
 *   - `always`            — whenever it is not available (shell: Bash tool
 *                           dropped; ripgrep: not on PATH and no prebuilt
 *                           binary for this platform).
 *   - `outside-git-repo`  — only when its fallback is unavailable (fd: the
 *                           `git ls-files` fallback only covers git repos).
 *   - `never`             — never warn, even when missing.
 */
export type StartupWarningPolicy = 'always' | 'outside-git-repo' | 'never';

export interface SystemDependency {
  readonly id: DependencyId;
  readonly displayName: string;
  readonly purpose: string;
  readonly requirement: DependencyRequirement;
  /** Whether the CLI can fetch this binary on demand (only ripgrep, today). */
  readonly autoBootstrap: boolean;
  /** Human note on the graceful-degradation path, if any. */
  readonly fallback?: string;
  readonly startupWarning: StartupWarningPolicy;
  /** Short, actionable install hint, aligned with `rgUnavailableMessage`. */
  readonly fixHint: string;
}

export const SYSTEM_DEPENDENCIES: readonly SystemDependency[] = [
  {
    id: 'ripgrep',
    displayName: 'ripgrep (rg)',
    purpose: 'Powers the Grep tool and file-content search.',
    requirement: 'required',
    autoBootstrap: true,
    // Self-heals on supported platforms (auto-download), so a warning only
    // fires when it is neither on PATH nor downloadable for this platform.
    startupWarning: 'always',
    fixHint:
      'Install ripgrep: macOS `brew install ripgrep`, Ubuntu `sudo apt-get install ripgrep`, others https://github.com/BurntSushi/ripgrep#installation.',
  },
  {
    id: 'fd',
    displayName: 'fd',
    purpose: 'Cross-directory fuzzy file search for `@` mentions.',
    requirement: 'optional',
    autoBootstrap: false,
    fallback: 'Inside a git repository, `git ls-files` still powers `@` completion.',
    startupWarning: 'outside-git-repo',
    fixHint: 'Install fd: macOS `brew install fd`, Ubuntu `sudo apt-get install fd-find`.',
  },
  {
    id: 'shell',
    displayName: 'shell (Git Bash on Windows)',
    purpose: 'Required by the Bash tool to run shell commands.',
    requirement: 'required',
    autoBootstrap: false,
    fallback: 'The Bash tool is omitted; file, search, and planning tools still work.',
    startupWarning: 'always',
    fixHint:
      'Install Git for Windows from https://gitforwindows.org/ or set KIMI_SHELL_PATH to a bash.exe.',
  },
];

export function getDependency(id: DependencyId): SystemDependency {
  const dep = SYSTEM_DEPENDENCIES.find((d) => d.id === id);
  if (dep === undefined) {
    throw new Error(`Unknown system dependency: ${id}`);
  }
  return dep;
}
