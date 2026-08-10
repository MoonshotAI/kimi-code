#!/usr/bin/env node
/**
 * Kimi Code Rust distribution shell — spawn the platform Rust binary.
 *
 * CI packs the built binary next to this script using pack.mjs naming:
 *   bin/kimi-<platform>-<arch>[.exe]
 * (or a generic `kimi`/`kimi.exe` when platform-specific builds are absent).
 *
 * `KIMI_RUST_BIN` overrides the binary path (dev/test use), and a missing
 * binary produces a clear build hint instead of a cryptic spawn error.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HERE = import.meta.dirname;
const exe = process.platform === 'win32' ? '.exe' : '';
const candidates = [
  // pack.mjs default naming: kimi-<platform>-<arch>[.exe]
  `kimi-${process.platform}-${process.arch}${exe}`,
  // generic name for hand-installed builds
  `kimi${exe}`,
  // legacy cross-platform names
  'kimi-win32-x64.exe',
  'kimi.exe',
  'kimi-linux-x64',
  'kimi-darwin-arm64',
  'kimi',
];
const explicit = process.env.KIMI_RUST_BIN;

const binary = explicit ?? candidates.map((c) => join(HERE, c)).find((p) => existsSync(p));

if (!binary) {
  console.error(
    'kimi: Rust binary not found in ' + HERE +
    '\n  Build it with `cargo build --release -p kimi-cli` and copy target/release/kimi(.exe) here, or set KIMI_RUST_BIN.',
  );
  process.exit(1);
}

/**
 * The Rust `web` subcommand serves the SPA only when `--assets` is given
 * (API-only otherwise); inject it when this distribution ships a dist-web
 * next to the wrapper (apps/kimi-code does, the rust-bin package does not).
 */
function forwardArgs(raw) {
  if (raw[0] !== 'web') return raw;
  if (raw.slice(1).includes('--assets')) return raw;
  const distWeb = resolve(HERE, '..', 'dist-web');
  if (!existsSync(distWeb)) return raw;
  return [raw[0], '--assets', distWeb, ...raw.slice(1)];
}

const result = spawnSync(binary, forwardArgs(process.argv.slice(2)), { stdio: 'inherit' });
if (result.error) {
  console.error('kimi: failed to spawn Rust binary:', result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
