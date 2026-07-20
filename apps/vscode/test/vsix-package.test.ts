/**
 * Scenario: maintainers package and inspect the VS Code extension on any host OS.
 * Responsibilities: six-target argument handling, actionable failures, isolated
 * dev state, manifest/resource hygiene, unresolved imports, and entry loading.
 * Wiring: real Node packaging/verifier CLIs and filesystem; VSIX directory
 * fixtures replace only the external Marketplace archive producer.
 * Run: pnpm --filter kimi-code exec vitest run --config vitest.config.ts test/vsix-package.test.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const appRoot = resolve(import.meta.dirname, '..');
const packageScript = join(appRoot, 'scripts', 'vsix-package.mjs');
const verifierScript = join(appRoot, 'scripts', 'vsix-verify.mjs');
const prepareDevScript = join(appRoot, 'scripts', 'prepare-dev.mjs');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('VSIX package CLI (target planning and validation)', () => {
  it('plans all six supported targets when no target is supplied', async () => {
    const outputDir = await makeTempDir('kimi-package-plan-');

    const result = runNode(packageScript, ['--dry-run', '--out-dir', outputDir]);

    expect(result.status).toBe(0);
    expect(result.stdout.match(/Would package /g)).toHaveLength(6);
    expect(result.stdout).toContain('kimi-code-darwin-x64.vsix');
    expect(result.stdout).toContain('kimi-code-darwin-arm64.vsix');
    expect(result.stdout).toContain('kimi-code-linux-x64.vsix');
    expect(result.stdout).toContain('kimi-code-linux-arm64.vsix');
    expect(result.stdout).toContain('kimi-code-win32-x64.vsix');
    expect(result.stdout).toContain('kimi-code-win32-arm64.vsix');
  });

  it('accepts a Windows ARM target when the output path contains spaces', async () => {
    const root = await makeTempDir('kimi-package-windows-');
    const outputDir = join(root, 'output with spaces');

    const result = runNode(packageScript, [
      '--',
      '--dry-run',
      '--target',
      'win32-arm64',
      '--out-dir',
      outputDir,
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.match(/Would package /g)).toHaveLength(1);
    expect(result.stdout).toContain('kimi-code-win32-arm64.vsix');
  });

  it('rejects an unknown target before a build starts', () => {
    const result = runNode(packageScript, ['plan9-x64', '--dry-run']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown VSIX target "plan9-x64"');
    expect(result.stderr).toContain('win32-arm64');
  });
});

describe('VSIX verifier CLI (package contract and failure details)', () => {
  it('passes an unpacked Windows package when the entry is self-contained', async () => {
    const fixture = await makeVsixFixture('win32-x64');

    const result = runNode(verifierScript, [
      '--target',
      'win32-x64',
      '--directory',
      fixture,
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('static audit and entry import smoke passed (package-only)');
  });

  it('reports the expected target when the VSIX manifest has a different target', async () => {
    const fixture = await makeVsixFixture('darwin-arm64');

    const result = runNode(verifierScript, [
      '--target',
      'linux-x64',
      '--directory',
      fixture,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('VSIX manifest target is darwin-arm64, expected linux-x64');
  });

  it('names a missing required Webview resource', async () => {
    const fixture = await makeVsixFixture('darwin-x64');
    await rm(join(fixture, 'extension', 'dist', 'webview.js'));

    const result = runNode(verifierScript, [
      '--target',
      'darwin-x64',
      '--directory',
      fixture,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Required VSIX resource is missing: extension/dist/webview.js');
  });

  it('reports a bare runtime dependency left in the extension bundle', async () => {
    const fixture = await makeVsixFixture('linux-arm64');
    await writeFile(
      join(fixture, 'extension', 'dist', 'extension.js'),
      "import leftPad from 'left-pad';\nexport function activate() { return leftPad; }\n",
    );

    const result = runNode(verifierScript, [
      '--target',
      'linux-arm64',
      '--directory',
      fixture,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Bare runtime dependency "left-pad"');
  });

  it('rejects generated session state inside the package', async () => {
    const fixture = await makeVsixFixture('win32-arm64');
    const stateDir = join(fixture, 'extension', 'runtime', 'profile');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'session.json'), '{}');

    const result = runNode(verifierScript, [
      '--target',
      'win32-arm64',
      '--directory',
      fixture,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Forbidden package path segment "runtime"');
  });

  it('rejects a persisted state directory inside the package', async () => {
    const fixture = await makeVsixFixture('win32-x64');
    const stateDir = join(fixture, 'extension', 'state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'extension.json'), '{}');

    const result = runNode(verifierScript, [
      '--target',
      'win32-x64',
      '--directory',
      fixture,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Forbidden package path segment "state"');
  });
});

describe('Extension Development Host setup (isolated local state)', () => {
  it('creates the complete isolated directory layout for a debug launch', async () => {
    const parent = await makeTempDir('kimi-dev-profile-');
    const baseDir = join(parent, 'vscode-extension-dev');

    const result = runNode(prepareDevScript, ['--base-dir', baseDir]);

    expect(result.status).toBe(0);
    await expect(readFile(join(baseDir, 'workspace', 'README.md'), 'utf8')).resolves.toContain(
      'Isolated Kimi Code extension development workspace',
    );
    await expect(directoryExists(join(baseDir, 'user-data'))).resolves.toBe(true);
    await expect(directoryExists(join(baseDir, 'extensions'))).resolves.toBe(true);
    await expect(directoryExists(join(baseDir, 'kimi-home'))).resolves.toBe(true);
  });

  it('refuses to clear a directory without the dedicated safety suffix', async () => {
    const unsafeDir = await makeTempDir('kimi-dev-unsafe-');
    await writeFile(join(unsafeDir, 'keep.txt'), 'keep');

    const result = runNode(prepareDevScript, ['--base-dir', unsafeDir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing to reset unsafe development directory');
    await expect(readFile(join(unsafeDir, 'keep.txt'), 'utf8')).resolves.toBe('keep');
  });
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function makeVsixFixture(target: string): Promise<string> {
  const root = await makeTempDir('kimi-vsix-fixture-');
  const extensionDir = join(root, 'extension');
  const distDir = join(extensionDir, 'dist');
  const resourcesDir = join(extensionDir, 'resources');
  await Promise.all([
    mkdir(distDir, { recursive: true }),
    mkdir(resourcesDir, { recursive: true }),
  ]);

  const packageJson = await readFile(join(appRoot, 'package.json'), 'utf8');
  await Promise.all([
    writeFile(join(root, '[Content_Types].xml'), '<Types />'),
    writeFile(
      join(root, 'extension.vsixmanifest'),
      `<PackageManifest><Metadata><Identity TargetPlatform="${target}" /></Metadata></PackageManifest>`,
    ),
    writeFile(join(extensionDir, 'package.json'), packageJson),
    writeFile(join(extensionDir, 'readme.md'), '# Fixture\n'),
    writeFile(join(extensionDir, 'LICENSE.txt'), 'fixture license\n'),
    writeFile(
      join(distDir, 'extension.js'),
      "/** @type {import('../types/index').Extension} */\nimport * as vscode from 'vscode';\nexport function activate() { return vscode; }\n",
    ),
    writeFile(join(distDir, 'webview.js'), 'globalThis.__kimiWebview = true;\n'),
    writeFile(join(distDir, 'kimi-banner-dark.svg'), '<svg />'),
    writeFile(join(distDir, 'kimi-banner-light.svg'), '<svg />'),
    writeFile(join(distDir, 'kimi-logo.png'), 'fixture'),
    writeFile(join(resourcesDir, 'kimi-icon-storefront.png'), 'fixture'),
    writeFile(join(resourcesDir, 'kimi-icon.svg'), '<svg />'),
  ]);
  return root;
}

function runNode(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: appRoot,
    encoding: 'utf8',
    env: { ...process.env, VSCE_PAT: '', OVSX_PAT: '' },
  });
  if (result.error !== undefined) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
