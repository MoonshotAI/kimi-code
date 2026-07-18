#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { appendFile, chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = resolve(REPO_ROOT, 'apps/kimi-code');
const INSTALL_DIR = resolve(homedir(), '.kimi-code/bin');
const SUPPORTED_NODE_VERSION = [24, 15, 0];
const PATH_MARKER = '# Kimi Code personal build';

const HELP = `Use the native build from this repository as the installed kimi command.

Usage:
  node scripts/use-personal-build.mjs [--dry-run]

Options:
  --dry-run  Validate prerequisites and show the planned actions without
             building or changing the installed command.
  -h, --help Show this help message.

After updating the personal branch, run this command again to rebuild it.
Supported platforms: Linux x64 and Windows x64.

See PERSONAL_BUILD.md for the full guide.
`;

function fail(message) {
  throw new Error(message);
}

function parseArgs(args) {
  let dryRun = false;

  for (const arg of args) {
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      return { help: true, dryRun: false };
    }
    fail(`Unknown option: ${arg}\n\n${HELP}`);
  }

  return { help: false, dryRun };
}

function compareVersions(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function validateRuntime() {
  if (!['linux', 'win32'].includes(process.platform) || process.arch !== 'x64') {
    fail(
      `Unsupported platform: ${process.platform}-${process.arch}. ` +
      'Only linux-x64 and win32-x64 are supported.',
    );
  }

  const currentNodeVersion = process.versions.node.split('.').map(Number);
  if (compareVersions(currentNodeVersion, SUPPORTED_NODE_VERSION) < 0) {
    fail(
      `Node.js >=${SUPPORTED_NODE_VERSION.join('.')} is required; ` +
      `current version is ${process.versions.node}.`,
    );
  }
}

function commandForPnpm(args) {
  if (process.platform !== 'win32') {
    return { command: 'pnpm', args };
  }

  const shellCommand = ['pnpm.cmd', ...args]
    .map((arg) => `"${String(arg).replaceAll('"', '""')}"`)
    .join(' ');
  return {
    command: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    options: { windowsVerbatimArguments: true },
  };
}

function runCommand(command, args, { capture = false, env = process.env, extraOptions = {} } = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
    ...extraOptions,
  });

  if (result.error !== undefined) {
    fail(`Failed to run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const details = capture
      ? [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join('\n')
      : '';
    fail(
      `Command failed with exit code ${String(result.status)}: ${command} ${args.join(' ')}` +
      (details.length > 0 ? `\n${details}` : ''),
    );
  }

  return capture ? result.stdout.trim() : '';
}

function runPnpm(args, options) {
  const invocation = commandForPnpm(args);
  return runCommand(invocation.command, invocation.args, {
    ...options,
    extraOptions: invocation.options,
  });
}

async function validatePnpm() {
  const rootPackage = JSON.parse(await readFile(resolve(REPO_ROOT, 'package.json'), 'utf8'));
  const expectedPnpmVersion = String(rootPackage.packageManager).replace(/^pnpm@/, '');
  const currentPnpmVersion = runPnpm(['--version'], { capture: true });

  if (currentPnpmVersion !== expectedPnpmVersion) {
    fail(
      `pnpm ${expectedPnpmVersion} is required; current version is ${currentPnpmVersion}. ` +
      'Run "corepack enable" and "corepack prepare" for this repository.',
    );
  }
}

function targetPaths() {
  const target = `${process.platform}-${process.arch}`;
  const executableName = process.platform === 'win32' ? 'kimi.exe' : 'kimi';
  const binaryPath = resolve(APP_ROOT, 'dist-native/bin', target, executableName);
  const launcherPath = resolve(INSTALL_DIR, process.platform === 'win32' ? 'kimi.cmd' : 'kimi');
  const officialBinaryPath = resolve(INSTALL_DIR, executableName);

  return { target, binaryPath, launcherPath, officialBinaryPath };
}

function quoteForPosixShell(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function createLinuxLauncher(binaryPath) {
  return [
    '#!/bin/sh',
    'export KIMI_CODE_NO_AUTO_UPDATE=1',
    `exec ${quoteForPosixShell(binaryPath)} "$@"`,
    '',
  ].join('\n');
}

export function createWindowsLauncher(binaryPath) {
  const escapedPath = binaryPath.replaceAll('%', '%%');
  return [
    '@echo off',
    'set "KIMI_CODE_NO_AUTO_UPDATE=1"',
    `"${escapedPath}" %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function replaceFileAtomically(path, contents, mode) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${String(process.pid)}`;
  const backupPath = `${path}.backup-${String(process.pid)}`;
  let hasBackup = false;

  try {
    await writeFile(temporaryPath, contents, { encoding: 'utf8', mode });
    if (process.platform !== 'win32') await chmod(temporaryPath, mode);

    if (process.platform === 'win32' && await pathExists(path)) {
      await rename(path, backupPath);
      hasBackup = true;
    }

    try {
      await rename(temporaryPath, path);
    } catch (error) {
      if (hasBackup) await rename(backupPath, path).catch(() => {});
      throw error;
    }

    if (hasBackup) await unlink(backupPath);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

function normalizePathEntry(path) {
  const unquoted = path.trim().replace(/^"(.*)"$/, '$1');
  const normalized = resolve(unquoted);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function currentPathContains(path) {
  const expected = normalizePathEntry(path);
  return (process.env.PATH ?? '')
    .split(delimiter)
    .filter((entry) => entry.trim().length > 0)
    .some((entry) => normalizePathEntry(entry) === expected);
}

function linuxProfilePath() {
  const shell = basename(process.env.SHELL ?? '');
  if (shell === 'zsh') return resolve(homedir(), '.zshrc');
  if (shell === 'bash') return resolve(homedir(), '.bashrc');
  return resolve(homedir(), '.profile');
}

async function ensureLinuxPath() {
  if (currentPathContains(INSTALL_DIR)) return { changed: false, path: null };

  const profilePath = linuxProfilePath();
  let profile = '';
  try {
    profile = await readFile(profilePath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  if (profile.includes(PATH_MARKER) || profile.includes('.kimi-code/bin')) {
    return { changed: false, path: profilePath };
  }

  const separator = profile.length > 0 && !profile.endsWith('\n') ? '\n' : '';
  await appendFile(
    profilePath,
    `${separator}\n${PATH_MARKER}\nexport PATH="$HOME/.kimi-code/bin:$PATH"\n`,
    'utf8',
  );
  return { changed: true, path: profilePath };
}

function ensureWindowsPath() {
  if (currentPathContains(INSTALL_DIR)) return { changed: false };

  const script = [
    '$target = $env:KIMI_PERSONAL_BIN_DIR.TrimEnd("\\")',
    '$userPath = [Environment]::GetEnvironmentVariable("Path", "User")',
    '$entries = if ([string]::IsNullOrWhiteSpace($userPath)) { @() } else { @($userPath -split ";") }',
    '$present = $entries | Where-Object {',
    '  [Environment]::ExpandEnvironmentVariables($_.Trim()).TrimEnd("\\") -ieq $target',
    '}',
    'if ($null -eq $present) {',
    '  $newPath = if ([string]::IsNullOrWhiteSpace($userPath)) {',
    '    $env:KIMI_PERSONAL_BIN_DIR',
    '  } else {',
    '    "$userPath;$($env:KIMI_PERSONAL_BIN_DIR)"',
    '  }',
    '  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")',
    '  Write-Output "added"',
    '} else {',
    '  Write-Output "present"',
    '}',
  ].join('; ');

  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: REPO_ROOT,
    env: { ...process.env, KIMI_PERSONAL_BIN_DIR: INSTALL_DIR },
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.error !== undefined) {
    fail(`Failed to update the Windows user PATH: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`Failed to update the Windows user PATH:\n${result.stderr.trim()}`);
  }

  return { changed: result.stdout.trim() === 'added' };
}

function buildCommands() {
  return [
    ['pnpm', ['install', '--frozen-lockfile']],
    ['pnpm', ['--filter', '@moonshot-ai/kimi-web', 'run', 'build']],
    [process.execPath, ['apps/kimi-code/scripts/copy-web-assets.mjs']],
    ['pnpm', ['--filter', '@moonshot-ai/kimi-code', 'run', 'build:native:sea']],
    ['pnpm', ['--filter', '@moonshot-ai/kimi-code', 'run', 'test:native:smoke']],
  ];
}

function printDryRun(paths) {
  console.log('Personal build dry run');
  console.log(`Repository:       ${REPO_ROOT}`);
  console.log(`Build target:     ${paths.target}`);
  console.log(`Native binary:    ${paths.binaryPath}`);
  console.log(`Installed command:${paths.launcherPath}`);
  if (process.platform === 'win32') {
    console.log(`Official binary:  ${paths.officialBinaryPath} (removed after a successful build)`);
  } else {
    console.log(`Official binary:  ${paths.officialBinaryPath} (replaced after a successful build)`);
  }
  console.log(`PATH action:      ${currentPathContains(INSTALL_DIR) ? 'none' : `add ${INSTALL_DIR}`}`);
  console.log('\nCommands that would run:');
  for (const [command, args] of buildCommands()) {
    console.log(`  ${command} ${args.join(' ')}`);
  }
}

async function buildNativeBinary() {
  console.log('==> Installing dependencies');
  runPnpm(['install', '--frozen-lockfile']);

  console.log('==> Building Kimi web assets');
  runPnpm(['--filter', '@moonshot-ai/kimi-web', 'run', 'build']);
  runCommand(process.execPath, ['apps/kimi-code/scripts/copy-web-assets.mjs']);

  console.log('==> Building native Kimi Code executable');
  runPnpm(['--filter', '@moonshot-ai/kimi-code', 'run', 'build:native:sea']);

  console.log('==> Running native smoke tests');
  runPnpm(['--filter', '@moonshot-ai/kimi-code', 'run', 'test:native:smoke']);
}

async function installLauncher(paths) {
  if (!await pathExists(paths.binaryPath)) {
    fail(`Native build did not produce the expected executable: ${paths.binaryPath}`);
  }

  if (process.platform === 'win32') {
    await replaceFileAtomically(paths.launcherPath, createWindowsLauncher(paths.binaryPath), 0o644);
    if (paths.officialBinaryPath !== paths.launcherPath) {
      await unlink(paths.officialBinaryPath).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }
    return ensureWindowsPath();
  }

  await replaceFileAtomically(paths.launcherPath, createLinuxLauncher(paths.binaryPath), 0o755);
  return await ensureLinuxPath();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  validateRuntime();
  await validatePnpm();
  const paths = targetPaths();

  if (options.dryRun) {
    printDryRun(paths);
    return;
  }

  await buildNativeBinary();
  const pathResult = await installLauncher(paths);

  console.log('\nPersonal Kimi Code build installed.');
  console.log(`Repository:    ${REPO_ROOT}`);
  console.log(`Native binary: ${paths.binaryPath}`);
  console.log(`Command:       ${paths.launcherPath}`);
  console.log('Automatic official updates are disabled by the launcher.');
  if (pathResult.changed) {
    console.log('Open a new terminal before running kimi so the updated PATH is loaded.');
  } else if (!currentPathContains(INSTALL_DIR)) {
    console.log(`Ensure ${INSTALL_DIR} is loaded by your shell before running kimi.`);
  }
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
const modulePath = fileURLToPath(import.meta.url);
const isMain = process.platform === 'win32'
  ? invokedPath?.toLowerCase() === modulePath.toLowerCase()
  : invokedPath === modulePath;

if (isMain) {
  main().catch((error) => {
    console.error(`Personal build setup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
