import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wrapperPath = resolve(appRoot, 'bin', 'kimi.mjs');
const binDir = resolve(appRoot, 'bin');
const workspaceRoot = resolve(appRoot, '..', '..');
const exe = process.platform === 'win32' ? '.exe' : '';
const packageJson = JSON.parse(await readFile(resolve(appRoot, 'package.json'), 'utf-8'));
const expectedVersion = packageJson.version;

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Same candidate probing as bin/kimi.mjs (kept in sync with
// packages/kimi-code-rust-bin/bin/kimi.js).
const candidates = [
  `kimi-${process.platform}-${process.arch}${exe}`,
  `kimi${exe}`,
  'kimi-win32-x64.exe',
  'kimi.exe',
  'kimi-linux-x64',
  'kimi-darwin-arm64',
  'kimi',
];
const packedBinary = candidates.map((c) => join(binDir, c)).find((p) => existsSync(p));

async function runWrapper(args, extraEnv = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [wrapperPath, ...args], {
      cwd: appRoot,
      env: { ...process.env, KIMI_ENTRY_DEBUG: '1', ...extraEnv },
      maxBuffer: 1024 * 1024 * 16,
    });
    return { stdout, stderr };
  } catch (error) {
    const detail = [error.stdout?.trim(), error.stderr?.trim(), error.message]
      .filter(Boolean)
      .join('\n');
    fail(`Entry smoke failed: node ${wrapperPath} ${args.join(' ')}\n${detail}`);
  }
}

// 1. TS fallback — only meaningful when no Rust binary is reachable.
if (!packedBinary && !process.env.KIMI_RUST_BIN) {
  const { stdout, stderr } = await runWrapper(['--version']);
  if (stdout.trim() !== expectedVersion) {
    fail(`Entry smoke: TS fallback --version printed "${stdout.trim()}", expected "${expectedVersion}"`);
  }
  if (!stderr.includes('falling back to TS entry')) {
    fail(`Entry smoke: expected "falling back to TS entry" debug line, got stderr:\n${stderr}`);
  }
  console.log(`Entry smoke: TS fallback path OK (--version → ${expectedVersion})`);
} else {
  console.log(
    'Entry smoke: skip TS fallback check (a Rust binary is reachable in bin/ or via KIMI_RUST_BIN)',
  );
}

// 2. Rust path — KIMI_RUST_BIN > workspace target/debug > packed bin/.
const targetDebug = resolve(workspaceRoot, 'target', 'debug', `kimi${exe}`);
const rustBinary = process.env.KIMI_RUST_BIN ?? (existsSync(targetDebug) ? targetDebug : packedBinary);
if (rustBinary) {
  const { stdout, stderr } = await runWrapper(['--version'], { KIMI_RUST_BIN: rustBinary });
  if (!stderr.includes('using Rust binary')) {
    fail(`Entry smoke: expected "using Rust binary" debug line, got stderr:\n${stderr}`);
  }
  if (stdout.includes(expectedVersion)) {
    fail(
      `Entry smoke: Rust --version printed TS version "${expectedVersion}" — wrapper did not prefer the Rust binary`,
    );
  }
  console.log(`Entry smoke: Rust binary path OK (${rustBinary}; --version → ${stdout.trim()})`);
} else {
  console.log('Entry smoke: skip Rust binary check (build it with `cargo build -p kimi-cli`)');
}

console.log('Entry smoke passed');
