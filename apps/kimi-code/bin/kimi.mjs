#!/usr/bin/env node
/**
 * Kimi Code unified entry (stage F) — prefer the platform Rust binary,
 * fall back to the TS bundle (`dist/main.mjs`) when no binary is present.
 *
 * During the migration both tracks coexist behind a single `kimi` bin:
 *
 *   - Rust binary: CI packs `cargo build --release -p kimi-cli` output into
 *     `bin/kimi-<platform>-<arch>[.exe]` (see packages/kimi-code-rust-bin
 *     scripts/pack.mjs for the naming); `KIMI_RUST_BIN` overrides the path
 *     for dev/test.
 *   - TS fallback: `dist/main.mjs` (built by `pnpm build`) keeps working as
 *     today, so existing installs without a Rust binary are unaffected.
 *
 * The wrapper mirrors codex-cli's bin pattern: it spawns the child with
 * inherited stdio, forwards SIGINT/SIGTERM/SIGHUP so interactive sessions
 * terminate predictably, and mirrors the child's exit code (or re-raises a
 * terminating signal). `KIMI_ENTRY_DEBUG=1` logs which path was chosen.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = import.meta.dirname;
const TS_ENTRY = resolve(HERE, '..', 'dist', 'main.mjs');

const DEBUG = process.env.KIMI_ENTRY_DEBUG === '1';
const debug = (message) => {
  if (DEBUG) console.error(`kimi-entry: ${message}`);
};

/**
 * Resolve the platform Rust binary, mirroring packages/kimi-code-rust-bin
 * bin/kimi.js candidate probing (Windows requires the `.exe` suffix).
 *
 * `KIMI_RUST_BIN` wins when set; a set-but-missing path is a config error and
 * fails fast rather than silently falling back to TS.
 */
function findRustBinary() {
  const explicit = process.env.KIMI_RUST_BIN;
  if (explicit) {
    if (existsSync(explicit)) return explicit;
    console.error(`kimi: KIMI_RUST_BIN is set but no such file: ${explicit}`);
    process.exit(1);
  }

  const { platform, arch } = process;
  const exe = platform === 'win32' ? '.exe' : '';
  const candidates = [
    // pack.mjs default naming: kimi-<platform>-<arch>[.exe]
    `kimi-${platform}-${arch}${exe}`,
    // generic name for hand-installed builds
    `kimi${exe}`,
    // legacy cross-platform list kept in sync with kimi-code-rust-bin
    'kimi-win32-x64.exe',
    'kimi.exe',
    'kimi-linux-x64',
    'kimi-darwin-arm64',
    'kimi',
  ];
  return candidates.map((candidate) => join(HERE, candidate)).find((p) => existsSync(p));
}

/**
 * The Rust `web` subcommand serves the SPA only when `--assets` is given
 * (API-only otherwise). The TS distribution ships dist-web next to this
 * wrapper, so point the Rust binary at it. The TS fallback resolves assets
 * itself and must never receive the flag.
 */
function forwardArgs(raw) {
  if (raw[0] !== 'web') return raw;
  if (raw.slice(1).includes('--assets')) return raw;
  const distWeb = resolve(HERE, '..', 'dist-web');
  if (!existsSync(distWeb)) return raw;
  debug(`injecting --assets ${distWeb} for the web subcommand`);
  return [raw[0], '--assets', distWeb, ...raw.slice(1)];
}

/**
 * Spawn the child with inherited stdio, forward termination signals, and
 * mirror its exit code (or re-raise the terminating signal) in the parent.
 */
async function runChild(command, args) {
  const child = spawn(command, args, { stdio: 'inherit' });

  child.on('error', (err) => {
    console.error(`kimi: failed to spawn ${command}: ${err.message}`);
    process.exit(1);
  });

  const forwardSignal = (signal) => {
    if (child.killed) return;
    try {
      child.kill(signal);
    } catch {
      /* ignore */
    }
  };
  ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((signal) => {
    process.on(signal, () => forwardSignal(signal));
  });

  const result = await new Promise((resolveChild) => {
    child.on('exit', (code, signal) => {
      if (signal) resolveChild({ type: 'signal', signal });
      else resolveChild({ type: 'code', exitCode: code ?? 1 });
    });
  });

  if (result.type === 'signal') {
    // Re-emit so the parent terminates with 128 + n semantics.
    process.kill(process.pid, result.signal);
  } else {
    process.exit(result.exitCode);
  }
}

const rustBinary = findRustBinary();
if (rustBinary) {
  debug(`using Rust binary: ${rustBinary}`);
  await runChild(rustBinary, forwardArgs(process.argv.slice(2)));
} else if (existsSync(TS_ENTRY)) {
  debug(`Rust binary not found; falling back to TS entry: ${TS_ENTRY}`);
  await runChild(process.execPath, [TS_ENTRY, ...process.argv.slice(2)]);
} else {
  console.error(
    'kimi: no Rust binary found and TS fallback missing at ' + TS_ENTRY +
    '\n  Build the Rust CLI (`cargo build --release -p kimi-cli`) and copy target/release/kimi(.exe) into bin/, ' +
    'or build the TS bundle (`pnpm build`) first.',
  );
  process.exit(1);
}
