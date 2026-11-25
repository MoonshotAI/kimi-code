import { mkdtemp, link, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { c as createTar } from 'tar';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error JavaScript build script has no declaration file.
import { prepareWindowsBash, verifyWindowsBashRuntime } from '../../../scripts/prepare-windows-bash.mjs';

const temporaryDirs: string[] = [];
const requiredFiles = [
  'bash.exe', 'sh.exe', 'cygpath.exe', 'msys-2.0.dll', 'cat.exe', 'grep.exe',
  'sed.exe', 'gawk.exe', 'find.exe', 'xargs.exe', 'diff.exe', 'patch.exe',
  'tar.exe', 'gzip.exe', 'bzip2.exe', 'xz.exe', 'unzip.exe', 'which.exe',
];

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace() {
  const dir = await mkdtemp(path.join(tmpdir(), 'kimi-windows-bash-'));
  temporaryDirs.push(dir);
  return dir;
}

async function makePackage(dir: string, options: { depends?: string[]; traversal?: boolean } = {}) {
  const source = path.join(dir, 'source');
  const bin = path.join(source, 'usr', 'bin');
  await mkdir(bin, { recursive: true });
  for (const file of requiredFiles) await writeFile(path.join(bin, file), file === 'bash.exe' ? 'bash' : file);
  await writeFile(path.join(bin, 'bash.exe'), 'bash');
  await symlink('bash.exe', path.join(bin, 'alias.exe'));
  await link(path.join(bin, 'bash.exe'), path.join(bin, 'hardlink.exe'));
  await mkdir(path.join(source, 'usr', 'share', 'doc', 'bash'), { recursive: true });
  await writeFile(path.join(source, 'usr', 'share', 'doc', 'bash', 'COPYING'), 'license');
  await writeFile(path.join(source, 'usr', 'share', 'doc', 'bash', 'README'), 'docs');
  await mkdir(path.join(source, 'usr', 'share', 'locale', 'zh_CN'), { recursive: true });
  await writeFile(path.join(source, 'usr', 'share', 'locale', 'zh_CN', 'bash.mo'), 'locale');
  const dependencies = options.depends ?? [];
  await writeFile(path.join(source, '.PKGINFO'), [
    'pkgname = bash',
    'pkgbase = bash',
    'pkgver = 1-1',
    'pkgdesc = test package',
    'url = https://example.test/bash',
    'license = GPL3',
    'provides = sh',
    ...dependencies.map((dependency) => `depend = ${dependency}`),
    '',
  ].join('\n'));
  if (options.traversal === true) {
    await writeFile(path.join(dir, 'outside.txt'), 'outside');
  }
  const tarPath = path.join(dir, 'package.tar');
  await createTar({ cwd: source, file: tarPath, sync: true }, options.traversal === true ? ['.', '../outside.txt'] : ['.']);
  const cacheDir = path.join(dir, 'cache');
  await mkdir(cacheDir, { recursive: true });
  const filename = 'bash-1-1-x86_64.pkg.tar.zst';
  const body = zstdCompressSync(await readFile(tarPath));
  await writeFile(path.join(cacheDir, filename), body);
  const lockPath = path.join(dir, 'lock.json');
  await writeFile(lockPath, JSON.stringify({
    schemaVersion: 1,
    architecture: 'x86_64',
    directPackages: ['bash'],
    packages: [{
      name: 'bash',
      version: '1-1',
      base: 'bash',
      projectUrl: 'https://example.test/bash',
      licenses: ['GPL3'],
      filename,
      downloadUrl: `https://mirror.msys2.org/msys/x86_64/${filename}`,
      size: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
      depends: dependencies,
      provides: ['sh'],
      packagePage: 'https://example.test/bash-package',
      sourceUrl: 'https://mirror.msys2.org/msys/sources/bash-1-1.src.tar.zst',
    }],
  }));
  return { lockPath, cacheDir, outputDir: path.join(dir, 'output') };
}

describe('prepareWindowsBash', () => {
  it('skips non-Windows platforms', async () => {
    expect(await prepareWindowsBash({ platform: 'darwin' })).toEqual({ skipped: true });
  });

  it('prepares a complete runtime from a locked package', async () => {
    const dir = await workspace();
    const options = await makePackage(dir);
    const result = await prepareWindowsBash({ platform: 'win32', ...options });
    expect(result.files).toBeGreaterThan(requiredFiles.length);
    expect(await readFile(path.join(options.outputDir, 'bin', 'bash.exe'), 'utf8')).toBe('bash');
    expect(await readFile(path.join(options.outputDir, 'usr', 'bin', 'alias.exe'), 'utf8')).toBe('bash');
    expect(await readFile(path.join(options.outputDir, 'usr', 'bin', 'hardlink.exe'), 'utf8')).toBe('bash');
    expect(await readFile(path.join(options.outputDir, 'licenses', 'bash', 'usr', 'share', 'doc', 'bash', 'COPYING'), 'utf8')).toBe('license');
    expect(await readFile(path.join(options.outputDir, 'licenses', 'common', 'GPL-3.0-or-later.txt'), 'utf8')).toContain('GNU GENERAL PUBLIC LICENSE');
    await expect(readFile(path.join(options.outputDir, 'usr', 'share', 'doc', 'bash', 'README'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(options.outputDir, 'usr', 'share', 'locale', 'zh_CN', 'bash.mo'), 'utf8')).rejects.toThrow();
    const manifest = JSON.parse(await readFile(path.join(options.outputDir, 'source-manifest.json'), 'utf8'));
    expect(manifest.packages).toHaveLength(1);
    expect(manifest.packages[0].binary.sha256).toHaveLength(64);
    await expect(prepareWindowsBash({ platform: 'win32', ...options })).resolves.toEqual(result);
  });

  it('rejects an incomplete dependency closure without replacing the current runtime', async () => {
    const dir = await workspace();
    const options = await makePackage(dir, { depends: ['missing-library'] });
    await mkdir(options.outputDir, { recursive: true });
    await writeFile(path.join(options.outputDir, 'sentinel'), 'current');
    await expect(prepareWindowsBash({ platform: 'win32', ...options })).rejects.toThrow('Unresolved dependency missing-library required by bash');
    expect(await readFile(path.join(options.outputDir, 'sentinel'), 'utf8')).toBe('current');
    await expect(readdir(options.outputDir)).resolves.toEqual(['sentinel']);
  });

  it('rejects archive path traversal', async () => {
    const dir = await workspace();
    const options = await makePackage(dir, { traversal: true });
    await expect(prepareWindowsBash({ platform: 'win32', ...options })).rejects.toThrow('Unsafe archive path');
    await expect(readFile(path.join(options.outputDir, 'outside.txt'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(dir, 'outside.txt'), 'utf8')).resolves.toBe('outside');
  });
});

describe('verifyWindowsBashRuntime', () => {
  it('rejects missing required files and forbidden Git executables', async () => {
    const dir = await workspace();
    await expect(verifyWindowsBashRuntime(dir)).rejects.toThrow();
    const options = await makePackage(dir);
    await prepareWindowsBash({ platform: 'win32', ...options });
    await writeFile(path.join(options.outputDir, 'usr', 'bin', 'git.exe'), 'git');
    await expect(verifyWindowsBashRuntime(options.outputDir)).rejects.toThrow('Forbidden Windows Bash runtime files');
  });
});
