import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = resolve(appRoot, 'dist', 'main.mjs');
const webIndexPath = resolve(appRoot, 'dist-web', 'index.html');
const packageJson = JSON.parse(await readFile(resolve(appRoot, 'package.json'), 'utf-8'));
const expectedVersion = packageJson.version;

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function ensureBundleExists() {
  try {
    await stat(bundlePath);
  } catch {
    fail(`Bundle not found at ${bundlePath}. Run \`pnpm build\` first.`);
  }
}

async function ensureRuntimeAssetsExist() {
  try {
    await stat(webIndexPath);
  } catch {
    fail(`Runtime asset not found at ${webIndexPath}. Run \`pnpm build\` first.`);
  }
}

async function runBundle(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [bundlePath, ...args], {
      cwd: appRoot,
      maxBuffer: 1024 * 1024 * 16,
    });
    return `${stdout}${stderr}`;
  } catch (error) {
    const detail = [error.stdout?.trim(), error.stderr?.trim(), error.message]
      .filter(Boolean)
      .join('\n');
    fail(`Bundle smoke failed: node ${bundlePath} ${args.join(' ')}\n${detail}`);
  }
}

function assertIncludes(output, expected, command) {
  if (!output.includes(expected)) {
    fail(`Bundle smoke output for "${command}" did not include "${expected}".\n${output}`);
  }
}

await ensureBundleExists();
await ensureRuntimeAssetsExist();

const versionOutput = await runBundle(['--version']);
assertIncludes(versionOutput, expectedVersion, '--version');

const helpOutput = await runBundle(['--help']);
assertIncludes(helpOutput, 'Usage: kimi', '--help');

const exportHelpOutput = await runBundle(['export', '--help']);
assertIncludes(exportHelpOutput, 'Usage: kimi export', 'export --help');

const webHelpOutput = await runBundle(['web', '--help']);
assertIncludes(webHelpOutput, 'Usage: kimi web', 'web --help');

console.log(`Bundle smoke passed: ${bundlePath}`);
