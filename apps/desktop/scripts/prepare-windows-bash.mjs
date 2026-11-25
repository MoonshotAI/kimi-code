import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import {
  appendFile,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createZstdDecompress } from 'node:zlib';
import { create as createTar, list as listTar, x as extractTar } from 'tar';
import lockfile from 'proper-lockfile';

const desktopDir = fileURLToPath(new URL('..', import.meta.url));
const defaultLockPath = path.join(desktopDir, 'build', 'windows-bash-packages.lock.json');
const defaultOutputDir = path.join(desktopDir, 'resources-stage', 'windows-bash');
const defaultCacheDir = path.join(desktopDir, 'resources-stage', 'windows-bash-cache');
const sourceBundleName = 'Windows-Bash-Sources.tar';

const requiredFiles = [
  'etc/fstab',
  'etc/nsswitch.conf',
  'usr/bin/bash.exe',
  'usr/bin/sh.exe',
  'usr/bin/cygpath.exe',
  'usr/bin/msys-2.0.dll',
  'usr/bin/cat.exe',
  'usr/bin/grep.exe',
  'usr/bin/sed.exe',
  'usr/bin/gawk.exe',
  'usr/bin/find.exe',
  'usr/bin/xargs.exe',
  'usr/bin/diff.exe',
  'usr/bin/patch.exe',
  'usr/bin/tar.exe',
  'usr/bin/gzip.exe',
  'usr/bin/bzip2.exe',
  'usr/bin/xz.exe',
  'usr/bin/unzip.exe',
  'usr/bin/which.exe',
  'bin/bash.exe',
  'bin/sh.exe',
];

function normalizeArchivePath(value) {
  const withoutPrefix = value.replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (withoutPrefix === '' || withoutPrefix === '.') return '';
  if (withoutPrefix.includes('\\') || withoutPrefix.includes('\0') || withoutPrefix.startsWith('/') || /^[A-Za-z]:/.test(withoutPrefix)) {
    throw new Error(`Unsafe archive path: ${value}`);
  }
  const normalized = path.posix.normalize(withoutPrefix);
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new Error(`Unsafe archive path: ${value}`);
  }
  return normalized;
}

function isNotice(filePath) {
  return /(?:^|\/)(?:[^/]*(?:licen[cs]e|copying|copyright|notice)[^/]*)$/i.test(filePath);
}

function shouldInclude(filePath) {
  if (filePath === '' || /^\.(?:PKGINFO|INSTALL|MTREE|BUILDINFO)$/.test(filePath)) return false;
  if (isNotice(filePath)) return true;
  return !/(?:^|\/)(?:man|info|locale|doc)(?:\/|$)/.test(filePath);
}

function parsePkgInfo(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    (result[match[1]] ??= []).push(match[2]);
  }
  return result;
}

async function inspectPackage(tarPath) {
  const entries = [];
  let pkgInfoText = '';
  let inspectionError;
  await listTar({
    file: tarPath,
    strict: true,
    onReadEntry: (entry) => {
      if (inspectionError !== undefined) return;
      try {
        const entryPath = normalizeArchivePath(entry.path);
        if (!['File', 'Directory', 'SymbolicLink', 'Link'].includes(entry.type)) {
          throw new Error(`Unsupported archive entry type ${entry.type}: ${entry.path}`);
        }
        const item = { path: entryPath, type: entry.type, linkpath: entry.linkpath };
        entries.push(item);
        if (entryPath === '.PKGINFO') {
          entry.on('data', (chunk) => {
            pkgInfoText += chunk.toString('utf8');
          });
        }
      } catch (error) {
        inspectionError = error;
      }
    },
  });
  if (inspectionError !== undefined) throw inspectionError;
  if (pkgInfoText === '') throw new Error(`Missing .PKGINFO in ${tarPath}`);
  return { entries, pkgInfo: parsePkgInfo(pkgInfoText) };
}

function resolveLink(entry) {
  const raw = entry.linkpath;
  if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\0') || raw.includes('\\')) {
    throw new Error(`Unsafe link in ${entry.path}`);
  }
  const combined = entry.type === 'SymbolicLink'
    ? raw.startsWith('/')
      ? raw.slice(1)
      : path.posix.join(path.posix.dirname(entry.path), raw)
    : raw;
  return normalizeArchivePath(combined);
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function validCachedPackage(filePath, pkg) {
  try {
    const info = await stat(filePath);
    return info.size === pkg.size && await sha256File(filePath) === pkg.sha256;
  } catch {
    return false;
  }
}

async function downloadPackage(pkg, cacheDir) {
  const destination = path.join(cacheDir, pkg.filename);
  if (await validCachedPackage(destination, pkg)) return destination;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const temporary = `${destination}.${randomUUID()}.download`;
    try {
      const url = attempt === 2 && pkg.mirrorUrl ? pkg.mirrorUrl : pkg.downloadUrl;
      const response = await fetch(url, {
        headers: { 'user-agent': 'KimiCodeDesktopBuild/1' },
        signal: AbortSignal.timeout(pkg.mirrorUrl ? 600_000 : 60_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > 0 && length !== pkg.size) {
        throw new Error(`Unexpected content length for ${pkg.filename}: ${length}`);
      }
      await pipeline(response.body, createWriteStream(temporary, { flags: 'wx' }));
      if (!await validCachedPackage(temporary, pkg)) throw new Error(`Size or SHA-256 mismatch for ${pkg.filename}`);
      try {
        await rename(temporary, destination);
      } catch (error) {
        if (!await validCachedPackage(destination, pkg)) throw error;
      }
      return destination;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    } finally {
      await rm(temporary, { force: true });
    }
  }
  throw lastError;
}

async function downloadAll(packages, cacheDir) {
  await mkdir(cacheDir, { recursive: true });
  const queue = [...packages];
  const files = new Map();
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length > 0) {
      const pkg = queue.shift();
      files.set(pkg.name, await downloadPackage(pkg, cacheDir));
    }
  });
  await Promise.all(workers);
  return files;
}

async function unpackPackage(pkg, tarPath, outputDir, owners) {
  const unpackedTar = path.join(path.dirname(outputDir), 'package.tar');
  await pipeline(createReadStream(tarPath), createZstdDecompress(), createWriteStream(unpackedTar));
  try {
    const { entries, pkgInfo } = await inspectPackage(unpackedTar);
    if (pkgInfo.pkgname?.[0] !== pkg.name || pkgInfo.pkgver?.[0] !== pkg.version) {
      throw new Error(`Package identity mismatch in ${pkg.filename}`);
    }
    for (const entry of entries) {
      if (entry.path === '' || !shouldInclude(entry.path)) continue;
      if (entry.type === 'File') {
        const previous = owners.get(entry.path);
        if (previous !== undefined) throw new Error(`${entry.path} is provided by both ${previous} and ${pkg.name}`);
        owners.set(entry.path, pkg.name);
      }
      if (entry.type === 'SymbolicLink' || entry.type === 'Link') entry.target = resolveLink(entry);
    }
    await extractTar({
      cwd: outputDir,
      file: unpackedTar,
      strict: true,
      preserveOwner: false,
      unlink: true,
      filter: (entryPath, entry) => shouldInclude(normalizeArchivePath(entryPath)) && ['File', 'Directory'].includes(entry.type),
    });
    for (const entry of entries) {
      if (entry.type !== 'File' || !isNotice(entry.path) || !shouldInclude(entry.path)) continue;
      const destination = path.join(outputDir, 'licenses', pkg.name, entry.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(outputDir, entry.path), destination);
    }
    return { entries, pkgInfo };
  } finally {
    await rm(unpackedTar, { force: true });
  }
}

function dependencyName(dependency) {
  return dependency.split(/[<>=]/, 1)[0];
}

function verifyDependencies(inspected, packages) {
  const providers = new Set();
  for (const pkg of packages) {
    providers.add(pkg.name);
    for (const provided of pkg.provides) providers.add(dependencyName(provided));
    const info = inspected.get(pkg.name).pkgInfo;
    for (const provided of info.provides ?? []) providers.add(dependencyName(provided));
  }
  for (const pkg of packages) {
    const dependencies = inspected.get(pkg.name).pkgInfo.depend ?? [];
    for (const dependency of dependencies) {
      const name = dependencyName(dependency);
      if (!providers.has(name)) throw new Error(`Unresolved dependency ${dependency} required by ${pkg.name}`);
    }
  }
}

async function materializeLinks(inspected, outputDir) {
  const links = [];
  for (const [pkgName, { entries }] of inspected) {
    for (const entry of entries) {
      if ((entry.type === 'SymbolicLink' || entry.type === 'Link') && shouldInclude(entry.path)) {
        links.push({ ...entry, pkgName });
      }
    }
  }
  const targets = new Map(links.map((entry) => [entry.path, entry.target]));
  for (const entry of links) {
    let target = entry.target;
    const visited = new Set([entry.path]);
    while (targets.has(target)) {
      if (visited.has(target)) throw new Error(`Link cycle at ${entry.path}`);
      visited.add(target);
      target = targets.get(target);
    }
    const source = path.join(outputDir, target);
    const destination = path.join(outputDir, entry.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}

function sourceManifest(lock) {
  return {
    schemaVersion: 1,
    architecture: lock.architecture,
    sourceBundle: sourceBundleName,
    packages: lock.packages.map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      base: pkg.base,
      projectUrl: pkg.projectUrl,
      licenses: pkg.licenses,
      packagePage: pkg.packagePage,
      sourceUrl: pkg.sourceUrl,
      sourceSha256: pkg.sourceSha256,
      binary: { filename: pkg.filename, size: pkg.size, sha256: pkg.sha256 },
    })),
  };
}

export async function bundleWindowsBashSources(outputDir, options = {}) {
  const lockPath = options.lockPath ?? defaultLockPath;
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  validateLock(lock);
  const sources = new Map();
  for (const pkg of lock.packages) {
    const url = new URL(pkg.sourceUrl);
    const filename = path.posix.basename(url.pathname);
    if (!/^[\w.+~-]+\.src\.tar\.zst$/.test(filename) || !/^[a-f0-9]{64}$/.test(pkg.sourceSha256) || !Number.isSafeInteger(pkg.sourceSize) || pkg.sourceSize <= 0) {
      throw new Error(`Invalid source archive for ${pkg.name}`);
    }
    const previous = sources.get(filename);
    if (previous && (previous.sha256 !== pkg.sourceSha256 || previous.size !== pkg.sourceSize || previous.mirrorUrl !== pkg.sourceUrl)) {
      throw new Error(`Conflicting source archive: ${filename}`);
    }
    url.hostname = 'repo.msys2.org';
    sources.set(filename, { name: filename, filename, sha256: pkg.sourceSha256, size: pkg.sourceSize, downloadUrl: url.href, mirrorUrl: pkg.sourceUrl });
  }
  const archives = await downloadAll(sources.values(), options.cacheDir ?? defaultCacheDir);
  await mkdir(outputDir, { recursive: true });
  const staging = await mkdtemp(path.join(outputDir, '.windows-bash-sources-'));
  try {
    const files = [...sources.keys()].sort();
    for (const filename of files) await copyFile(archives.get(filename), path.join(staging, filename));
    const checksums = files.map(filename => `${sources.get(filename).sha256}  ${filename}\n`).join('');
    await writeFile(path.join(staging, 'SHA256SUMS'), checksums);
    await mkdir(path.join(staging, 'build'));
    await mkdir(path.join(staging, 'scripts'));
    await copyFile(lockPath, path.join(staging, 'build', 'windows-bash-packages.lock.json'));
    await cp(path.join(desktopDir, 'build', 'windows-bash-licenses'), path.join(staging, 'build', 'windows-bash-licenses'), { recursive: true });
    for (const file of ['package.json', 'scripts/prepare-windows-bash.mjs', 'scripts/verify-windows-bash.sh']) {
      await copyFile(path.join(desktopDir, file), path.join(staging, file));
    }
    const archive = path.join(staging, sourceBundleName);
    await createTar({ cwd: staging, file: archive, portable: true }, [...files, 'SHA256SUMS', 'build', 'scripts', 'package.json']);
    await rename(archive, path.join(outputDir, sourceBundleName));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function walk(root, relative = '') {
  const result = [];
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await walk(root, child));
    else if (!entry.isFile()) throw new Error(`Unexpected non-regular file: ${child}`);
    else result.push(child);
  }
  return result;
}

export async function verifyWindowsBashRuntime(runtimeDir, options = {}) {
  const files = await walk(runtimeDir);
  const missing = requiredFiles.filter((file) => !files.includes(file));
  if (missing.length > 0) throw new Error(`Missing Windows Bash runtime files: ${missing.join(', ')}`);
  const { packageNotices } = JSON.parse(await readFile(new URL('../build/windows-bash-licenses/SOURCE.json', import.meta.url), 'utf8'));
  for (const [name, notice] of Object.entries(packageNotices)) {
    const relative = `licenses/common/${name}`;
    if (!files.includes(relative)) throw new Error(`Missing Windows Bash license notice: ${relative}`);
    if (await sha256File(path.join(runtimeDir, relative)) !== notice.sha256) {
      throw new Error(`Windows Bash license notice SHA-256 mismatch: ${relative}`);
    }
  }
  const forbidden = files.filter((file) => /(?:^|\/)(?:git|git-bash|pacman)(?:\.exe)?$|git-credential-/i.test(file));
  if (forbidden.length > 0) throw new Error(`Forbidden Windows Bash runtime files: ${forbidden.join(', ')}`);
  if (options.smoke === true && process.platform === 'win32') {
    const binDir = path.join(runtimeDir, 'usr', 'bin');
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const isolatedKeys = ['PATH', 'TMP', 'TEMP', 'TMPDIR', 'BASH_ENV', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERPROFILE'];
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !isolatedKeys.includes(key.toUpperCase())));
    env.PATH = [binDir, `${systemRoot}\\System32`, systemRoot].join(';');
    const userTemp = await mkdtemp(path.join(tmpdir(), 'kimi bash temp '));
    try {
      env.TMP = userTemp;
      env.TEMP = userTemp;
      env.USERPROFILE = path.join(userTemp, 'user profile');
      env.HOMEDRIVE = path.parse(userTemp).root.slice(0, -1);
      env.HOMEPATH = env.USERPROFILE.slice(env.HOMEDRIVE.length);
      await mkdir(env.USERPROFILE);
      const marker = path.basename(userTemp);
      await writeFile(path.join(userTemp, marker), 'from-windows');
      await writeFile(path.join(env.USERPROFILE, marker), 'from-profile');
      execFileSync(path.join(binDir, 'bash.exe'), ['-s', '--', marker], {
        input: await readFile(new URL('./verify-windows-bash.sh', import.meta.url)),
        env, cwd: runtimeDir, encoding: 'utf8', timeout: 30_000, windowsHide: true,
      });
    } finally {
      await rm(userTemp, { recursive: true, force: true });
    }
  }
  return {
    files: files.length,
    executables: files.filter((file) => file.toLowerCase().endsWith('.exe')).length,
    bytes: (await Promise.all(files.map(async (file) => (await stat(path.join(runtimeDir, file))).size))).reduce((a, b) => a + b, 0),
  };
}

async function replaceDirectory(source, destination) {
  const release = await lockfile.lock(destination, {
    realpath: false,
    retries: { retries: 120, minTimeout: 50, maxTimeout: 500, randomize: true },
  });
  try {
    await swapRuntimeDirectory(source, destination);
  } finally {
    await release();
  }
}

async function swapRuntimeDirectory(source, destination) {
  const backup = `${destination}.previous`;
  if (existsSync(backup)) {
    if (existsSync(destination)) await rm(backup, { recursive: true, force: true });
    else await rename(backup, destination);
  }
  let hasBackup = false;
  try {
    await rename(destination, backup);
    hasBackup = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await rename(source, destination);
  } catch (error) {
    if (hasBackup) await rename(backup, destination);
    throw error;
  }
  if (hasBackup) await rm(backup, { recursive: true, force: true });
}

function validateLock(lock) {
  if (lock.schemaVersion !== 1 || lock.architecture !== 'x86_64' || !Array.isArray(lock.packages)) {
    throw new Error('Unsupported Windows Bash package lock');
  }
  const names = new Set();
  for (const pkg of lock.packages) {
    if (names.has(pkg.name)) throw new Error(`Duplicate package: ${pkg.name}`);
    names.add(pkg.name);
    if (!pkg.downloadUrl.startsWith('https://mirror.msys2.org/') || !/^[a-f0-9]{64}$/.test(pkg.sha256) || !Number.isInteger(pkg.size) || !pkg.sourceUrl.startsWith('https://mirror.msys2.org/')) {
      throw new Error(`Invalid package lock entry: ${pkg.name}`);
    }
  }
  for (const direct of lock.directPackages) {
    if (!names.has(direct)) throw new Error(`Missing direct package: ${direct}`);
  }
}

export async function prepareWindowsBash(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return { skipped: true };
  const lockPath = options.lockPath ?? defaultLockPath;
  const outputDir = options.outputDir ?? defaultOutputDir;
  const cacheDir = options.cacheDir ?? defaultCacheDir;
  const lockText = await readFile(lockPath, 'utf8');
  const lock = JSON.parse(lockText);
  validateLock(lock);
  await mkdir(path.dirname(outputDir), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(outputDir), '.windows-bash-'));
  const temporary = path.join(staging, 'runtime');
  try {
    await mkdir(temporary);
    const archives = await downloadAll(lock.packages, cacheDir);
    const owners = new Map();
    const inspected = new Map();
    for (const pkg of lock.packages) {
      inspected.set(pkg.name, await unpackPackage(pkg, archives.get(pkg.name), temporary, owners));
    }
    verifyDependencies(inspected, lock.packages);
    await materializeLinks(inspected, temporary);
    await mkdir(path.join(temporary, 'bin'), { recursive: true });
    await copyFile(path.join(temporary, 'usr/bin/bash.exe'), path.join(temporary, 'bin/bash.exe'));
    await copyFile(path.join(temporary, 'usr/bin/sh.exe'), path.join(temporary, 'bin/sh.exe'));
    for (const directory of ['etc', 'dev', 'proc']) await mkdir(path.join(temporary, directory), { recursive: true });
    await appendFile(path.join(temporary, 'etc', 'fstab'), '\nnone / cygdrive binary,posix=0,noacl,user 0 0\nnone /tmp usertemp binary,posix=0 0 0\n');
    await appendFile(path.join(temporary, 'etc', 'nsswitch.conf'), '\ndb_home: env windows cygwin desc\n');
    await cp(path.join(desktopDir, 'build', 'windows-bash-licenses'), path.join(temporary, 'licenses', 'common'), { recursive: true });
    await writeFile(path.join(temporary, 'source-manifest.json'), `${JSON.stringify(sourceManifest(lock), null, 2)}\n`);
    const result = await verifyWindowsBashRuntime(temporary);
    await replaceDirectory(temporary, outputDir);
    return result;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv[2] === '--bundle-sources') {
    if (!process.argv[3]) throw new Error('--bundle-sources requires an output directory');
    await bundleWindowsBashSources(path.resolve(process.argv[3]));
    return;
  }
  const verifyIndex = process.argv.indexOf('--verify');
  if (verifyIndex >= 0) {
    const runtimeDir = process.argv[verifyIndex + 1];
    if (runtimeDir === undefined) throw new Error('--verify requires a runtime directory');
    const result = await verifyWindowsBashRuntime(path.resolve(runtimeDir), { smoke: true });
    console.log(`[windows-bash] verified ${result.files} files, ${result.executables} executables, ${(result.bytes / 1024 / 1024).toFixed(1)} MiB`);
    return;
  }
  const result = await prepareWindowsBash();
  if (result.skipped) return;
  console.log(`[windows-bash] prepared ${result.files} files, ${result.executables} executables, ${(result.bytes / 1024 / 1024).toFixed(1)} MiB`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[windows-bash] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
