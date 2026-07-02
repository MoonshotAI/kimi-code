/**
 * `agentFs` domain — shared ripgrep (`rg`) binary locator.
 *
 * Single place that decides which `rg` the Glob and Grep paths run. The lookup
 * mirrors v1's `ensureRgPath` intent (bundled-or-system, graceful degradation)
 * but is driven through a caller-supplied {@link RgProbe} so it works against
 * whatever execution environment the caller has — Glob probes through the
 * session `ISessionProcessRunner`, Grep through the shared runner as well.
 * Both run `rg --version` and treat exit code 0 as "available".
 *
 * Lookup order (first hit wins):
 *   1. System `rg` on the execution-environment PATH (`rg --version`).
 *   2. Persistent cache at `<KIMI_CODE_HOME|~/.kimi-code>/bin/rg` — where a
 *      previously bootstrapped or manually dropped static binary lives. Only
 *      attempted when `allowCachedFallback` is set (Glob); Grep keeps its own
 *      pure-node fallback and opts out so its "rg missing → node fallback"
 *      path stays deterministic.
 *
 * If nothing resolves, {@link ensureRgPath} throws and callers surface
 * {@link rgUnavailableMessage} instead of a naked `spawn rg ENOENT`.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where the resolved `rg` came from. Used for fallback telemetry. */
export type RgResolutionSource = 'system-path' | 'share-bin-cached';

export interface RgResolution {
  /** Command or absolute path to pass as argv[0] when spawning `rg`. */
  readonly path: string;
  readonly source: RgResolutionSource;
}

/**
 * Minimal probe surface the locator runs against. Lets the same locator run
 * over Glob's and Grep's `ISessionProcessRunner` without depending on either
 * directly.
 */
export interface RgProbe {
  /** Run `argv` and resolve with the process exit code. */
  exec(args: readonly string[]): Promise<{ readonly exitCode: number }>;
}

export interface EnsureRgPathOptions {
  /**
   * Cancels this caller's wait. Checked between probe steps; an aborted signal
   * makes {@link ensureRgPath} throw an `AbortError`.
   */
  readonly signal?: AbortSignal;
  /**
   * When true, fall back to the cached binary at `<share>/bin/rg` if `rg` is
   * not on PATH. Defaults to false so callers with their own fallback (Grep's
   * node walker) keep deterministic behavior.
   */
  readonly allowCachedFallback?: boolean;
}

function rgBinaryName(): string {
  return process.platform === 'win32' ? 'rg.exe' : 'rg';
}

function getShareDir(): string {
  const override = process.env['KIMI_CODE_HOME'];
  if (override !== undefined && override !== '') return override;
  return join(homedir(), '.kimi-code');
}

/** Absolute path of the cached `rg` binary, if one has been installed. */
export function getShareBinRgPath(): string {
  return join(getShareDir(), 'bin', rgBinaryName());
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

/**
 * Resolve a usable `rg`. Probes `rg --version` through `probe`; on a non-zero
 * exit (and only when `allowCachedFallback` is set) tries the cached binary
 * before giving up. Throws when no working `rg` can be found.
 */
export async function ensureRgPath(
  probe: RgProbe,
  options: EnsureRgPathOptions = {},
): Promise<RgResolution> {
  throwIfAborted(options.signal);

  const system = await probe.exec(['rg', '--version']).catch(() => ({ exitCode: -1 }));
  if (system.exitCode === 0) {
    return { path: 'rg', source: 'system-path' };
  }

  if (options.allowCachedFallback === true) {
    throwIfAborted(options.signal);
    const cached = getShareBinRgPath();
    const cachedRun = await probe.exec([cached, '--version']).catch(() => ({ exitCode: -1 }));
    if (cachedRun.exitCode === 0) {
      return { path: cached, source: 'share-bin-cached' };
    }
  }

  throw new Error('ripgrep (rg) is not available on PATH');
}

/**
 * User-facing message when {@link ensureRgPath} throws. Kept in one place so
 * the Glob / Grep plumbing surfaces the same actionable hint.
 */
export function rgUnavailableMessage(cause: unknown): string {
  const detail =
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'unknown error';
  const shareBin = getShareBinRgPath();
  return (
    `ripgrep (rg) is not available.\n` +
    `\n` +
    `Error: ${detail}\n` +
    `\n` +
    `Fix options:\n` +
    `  macOS:   brew install ripgrep\n` +
    `  Ubuntu:  sudo apt-get install ripgrep\n` +
    `  Other:   https://github.com/BurntSushi/ripgrep#installation\n` +
    `\n` +
    `Alternatively, drop a static rg binary at ${shareBin}`
  );
}
