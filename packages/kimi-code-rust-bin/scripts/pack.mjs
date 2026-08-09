#!/usr/bin/env node
/**
 * Pack the built Rust binary into this package's `bin/` with a platform name.
 *
 * Usage:
 *   node scripts/pack.mjs [--source <path>] [--target <name>]
 *
 * Defaults: source = target/release/kimi(.exe) (workspace root), target name =
 * `kimi-{process.platform}-{process.arch}` (plus `.exe` on win32).
 * Override with KIMI_RUST_SOURCE / KIMI_RUST_TARGET env vars.
 */
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const PACKAGE = resolve(HERE, '..');

const exe = process.platform === 'win32' ? '.exe' : '';
const defaultSource = join(ROOT, 'target', 'release', `kimi${exe}`);
const source = process.env.KIMI_RUST_SOURCE ?? defaultSource;
const defaultTarget = `kimi-${process.platform}-${process.arch}${exe}`;
const targetName = process.env.KIMI_RUST_TARGET ?? defaultTarget;

if (!existsSync(source)) {
  console.error(
    `kimi-code-rust-bin: source binary not found at ${source}\n` +
      '  Build it first: `cargo build --release -p kimi-cli`',
  );
  process.exit(1);
}

const target = join(PACKAGE, 'bin', targetName);
mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log(`packed ${source} -> ${target}`);

// Also pack the kimi-server-serve binary (the stdio/WS/HTTP server host) when
// present. It is optional — hosts can point KIMI_SERVER_BIN at a build — but
// shipping it removes the TS-host fallback-to-harness path in release
// packaging (CODEX_MIGRATION_PLAN §1.4 gap 6).
const serveSource = join(ROOT, 'target', 'release', `kimi-server-serve${exe}`);
if (existsSync(serveSource)) {
  const serveTarget = join(
    PACKAGE,
    'bin',
    `kimi-server-serve-${process.platform}-${process.arch}${exe}`,
  );
  copyFileSync(serveSource, serveTarget);
  console.log(`packed ${serveSource} -> ${serveTarget}`);
} else {
  console.warn(
    'kimi-server-serve not found; skipped. Build it with: ' +
      '`cargo build --release -p kimi-server-transport --bin kimi-server-serve`',
  );
}
