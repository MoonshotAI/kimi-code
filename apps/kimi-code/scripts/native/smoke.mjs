import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { appRoot, nativeBinPath, nativeSmokeHome, targetTriple } from './paths.mjs';

const execFileAsync = promisify(execFile);
const target = targetTriple();
const executablePath = nativeBinPath(target);
const smokeHome = nativeSmokeHome();
const packageJson = JSON.parse(await readFile(resolve(appRoot, 'package.json'), 'utf-8'));
const expectedVersion = packageJson.version;

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function ensureExecutableExists() {
  try {
    await stat(executablePath);
  } catch {
    fail(`Native executable not found at ${executablePath}. Run build:native:sea first.`);
  }
}

async function runKimi(args) {
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, args, {
      cwd: appRoot,
      maxBuffer: 1024 * 1024 * 16,
    });
    return `${stdout}${stderr}`;
  } catch (error) {
    const detail = [error.stdout?.trim(), error.stderr?.trim(), error.message]
      .filter(Boolean)
      .join('\n');
    fail(`Native smoke failed: ${executablePath} ${args.join(' ')}\n${detail}`);
  }
}

async function runKimiWithEnv(args, env) {
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, args, {
      cwd: appRoot,
      env: { ...process.env, ...env },
      maxBuffer: 1024 * 1024 * 16,
    });
    return `${stdout}${stderr}`;
  } catch (error) {
    const detail = [error.stdout?.trim(), error.stderr?.trim(), error.message]
      .filter(Boolean)
      .join('\n');
    fail(`Native smoke failed: ${executablePath} ${args.join(' ')}\n${detail}`);
  }
}

function assertIncludes(output, expected, command) {
  if (!output.includes(expected)) {
    fail(`Native smoke output for "${command}" did not include "${expected}".\n${output}`);
  }
}

await ensureExecutableExists();

const versionOutput = await runKimi(['--version']);
assertIncludes(versionOutput, expectedVersion, '--version');

const helpOutput = await runKimi(['--help']);
assertIncludes(helpOutput, 'Usage: kimi', '--help');

const exportHelpOutput = await runKimi(['export', '--help']);
assertIncludes(exportHelpOutput, 'Usage: kimi export', 'export --help');

const smokeCache = resolve(smokeHome, 'cache');
await rm(smokeHome, { recursive: true, force: true });
await mkdir(smokeCache, { recursive: true });
try {
  const nativeAssetOutput = await runKimiWithEnv(['--version'], {
    KIMI_CODE_CACHE_DIR: smokeCache,
    KIMI_CODE_HOME: smokeHome,
    KIMI_CODE_NATIVE_ASSET_SMOKE: '1',
  });
  assertIncludes(nativeAssetOutput, `Native asset smoke passed: ${target}`, 'native asset smoke');
  assertIncludes(nativeAssetOutput, 'MiniDb worker build passed', 'MiniDb worker smoke');
  assertIncludes(nativeAssetOutput, 'search worker ready', 'search worker smoke');
} finally {
  await rm(smokeHome, { recursive: true, force: true });
}

console.log(`Native smoke passed: ${executablePath}`);
