#!/usr/bin/env node
/**
 * Kimi Code Rust distribution shell — spawn the platform Rust binary.
 *
 * CI packs the built binary next to this script as:
 *   bin/kimi-win32-x64.exe / bin/kimi-linux-x64 / bin/kimi-darwin-arm64
 * (or a generic `kimi`/`kimi.exe` when platform-specific builds are absent).
 *
 * `KIMI_RUST_BIN` overrides the binary path (dev/test use), and a missing
 * binary produces a clear build hint instead of a cryptic spawn error.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const candidates = ['kimi-win32-x64.exe', 'kimi.exe', 'kimi-linux-x64', 'kimi-darwin-arm64', 'kimi'];
const explicit = process.env.KIMI_RUST_BIN;

const binary = explicit ?? candidates.map((c) => join(HERE, c)).find((p) => existsSync(p));

if (!binary) {
  console.error(
    'kimi: Rust binary not found in ' + HERE +
    '\n  Build it with `cargo build --release -p kimi-cli` and copy target/release/kimi(.exe) here, or set KIMI_RUST_BIN.',
  );
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
if (result.error) {
  console.error('kimi: failed to spawn Rust binary:', result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
