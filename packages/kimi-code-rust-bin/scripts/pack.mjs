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
