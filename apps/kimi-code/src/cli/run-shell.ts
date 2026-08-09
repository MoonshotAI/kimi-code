/**
 * Interactive shell entry (stage F / G-6) — the TypeScript TUI is retired:
 * the `kimi` bin wrapper prefers the Rust binary, so a TS install that
 * reaches this path has no Rust binary on disk. The shell delegates to a
 * Rust binary when one is discoverable (`KIMI_RUST_BIN` or the packed
 * candidates), or exits with a clear message.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { t } from '#/i18n';

const HERE = import.meta.dirname;

/**
 * Resolve the platform Rust binary, mirroring `bin/kimi.mjs` candidate
 * probing (Windows requires the `.exe` suffix). `KIMI_RUST_BIN` wins; a
 * set-but-missing path is a config error and fails fast.
 */
function findRustBinary(): string | null {
  const explicit = process.env['KIMI_RUST_BIN'];
  if (explicit) {
    if (existsSync(explicit)) return explicit;
    throw new Error(`KIMI_RUST_BIN is set but no such file: ${explicit}`);
  }
  const { platform, arch } = process;
  const exe = platform === 'win32' ? '.exe' : '';
  const candidates = [
    `kimi-${platform}-${arch}${exe}`,
    `kimi${exe}`,
    'kimi-win32-x64.exe',
    'kimi.exe',
    'kimi-linux-x64',
    'kimi-darwin-arm64',
    'kimi',
  ];
  return candidates.map((name) => resolve(HERE, '..', '..', 'bin', name)).find(existsSync) ?? null;
}

/**
 * The TS shell is a pure forwarder now: it replays the original argv so the
 * Rust CLI parses flags itself, and mirrors the child's exit code. This
 * keeps `kimi` (interactive) working on packed/dual-track installs without
 * the TS TUI bundle.
 */
export async function runShell(
  _opts: unknown,
  _version: string,
  _runOptions: { readonly migrateOnly?: boolean } = {},
): Promise<void> {
  const bin = findRustBinary();
  if (bin === null) {
    process.stderr.write(t('tui.statusMessages.shellNoRustBinary') + '\n');
    return;
  }
  const result = spawnSync(bin, process.argv.slice(2), { stdio: 'inherit' });
  if (result.status !== null) {
    process.exit(result.status);
  }
  if (result.signal !== null) {
    process.kill(process.pid, result.signal);
  }
  process.exit(1);
}
