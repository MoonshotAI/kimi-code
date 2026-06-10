#!/usr/bin/env node
import { createWriteStream } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import yazl from 'yazl';

import { readPluginManifestVersion } from './plugin-manifest-version.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '../../..');
const DEFAULT_PLUGINS_ROOT = resolve(REPO_ROOT, 'plugins');
const DEFAULT_OUT_DIR = resolve(DEFAULT_PLUGINS_ROOT, 'cdn');
const SENTINEL = '.kimi-plugin-marketplace-build.json';
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const SKIP_FILES = new Set(['.DS_Store']);

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const pluginsRoot = resolve(options.pluginsRoot ?? DEFAULT_PLUGINS_ROOT);
    const outDir = resolve(options.outDir ?? DEFAULT_OUT_DIR);
    await buildPluginMarketplaceCdn({ pluginsRoot, outDir });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

export async function buildPluginMarketplaceCdn({ pluginsRoot, outDir }) {
  assertSafeOutputDir(pluginsRoot, outDir);
  await prepareOutputDir(outDir);

  const marketplacePath = resolveInsideRoot(pluginsRoot, 'marketplace.json');
  const raw = await readFile(marketplacePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed.plugins)) {
    throw new Error('plugins/marketplace.json must contain a "plugins" array.');
  }

  const archives = [];
  const plugins = [];
  for (const entry of parsed.plugins) {
    if (!isRecord(entry) || typeof entry.source !== 'string') {
      plugins.push(entry);
      continue;
    }
    const result = await materializeEntrySource(entry.source, pluginsRoot, outDir);
    let stamped = { ...entry, source: result.source };
    if (isLocalRelativeSource(entry.source)) {
      // Stamp the version from the plugin's real manifest so "latest" stays truthful.
      const version = await readPluginManifestVersion(resolveInsideRoot(pluginsRoot, entry.source));
      if (version !== undefined) stamped = { ...stamped, version };
    }
    plugins.push(stamped);
    if (result.archive !== undefined) archives.push(result.archive);
  }

  const outputMarketplace = {
    ...parsed,
    plugins,
  };
  await writeFile(
    resolveInsideRoot(outDir, 'marketplace.json'),
    JSON.stringify(outputMarketplace, null, 2) + '\n',
    'utf8',
  );
  await writeFile(
    resolveInsideRoot(outDir, SENTINEL),
    JSON.stringify(
      {
        generatedBy: 'build-plugin-marketplace-cdn',
        generatedAt: new Date().toISOString(),
        pluginsRoot,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  process.stdout.write(`Plugin marketplace CDN artifacts written to ${outDir}\n`);
  process.stdout.write(`  marketplace.json\n`);
  for (const archive of archives) {
    process.stdout.write(`  ${archive}\n`);
  }
}

async function materializeEntrySource(source, pluginsRoot, outDir) {
  if (!isLocalRelativeSource(source)) return { source };

  const sourcePath = resolveInsideRoot(pluginsRoot, source);
  const info = await stat(sourcePath).catch(() => undefined);
  if (info === undefined) {
    throw new Error(`Marketplace source does not exist: ${source}`);
  }

  if (info.isDirectory()) {
    const zipSource = withZipExtension(source);
    const zipRel = stripRelativePrefix(zipSource);
    await zipDirectory(sourcePath, resolveInsideRoot(outDir, zipRel));
    return { source: zipSource, archive: zipRel };
  }

  if (info.isFile() && extname(sourcePath) === '.zip') {
    const zipRel = stripRelativePrefix(source);
    await mkdir(dirname(resolveInsideRoot(outDir, zipRel)), { recursive: true });
    await cp(sourcePath, resolveInsideRoot(outDir, zipRel));
    return { source, archive: zipRel };
  }

  throw new Error(`Marketplace source must be a directory or .zip file: ${source}`);
}

async function zipDirectory(sourceRoot, outputFile) {
  await mkdir(dirname(outputFile), { recursive: true });
  const zipfile = new yazl.ZipFile();
  const output = createWriteStream(outputFile);
  const done = new Promise((resolveDone, rejectDone) => {
    output.on('close', resolveDone);
    output.on('error', rejectDone);
    zipfile.outputStream.on('error', rejectDone);
  });
  zipfile.outputStream.pipe(output);
  await addDirectoryToZip(zipfile, sourceRoot, basename(sourceRoot));
  zipfile.end();
  await done;
}

async function addDirectoryToZip(zipfile, root, zipRoot) {
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    if (entry.isFile() && SKIP_FILES.has(entry.name)) continue;

    const absolutePath = resolve(root, entry.name);
    const zipPath = `${zipRoot}/${relative(root, absolutePath).replaceAll(sep, '/')}`;
    if (entry.isDirectory()) {
      await addDirectoryToZip(zipfile, absolutePath, zipPath);
    } else if (entry.isFile()) {
      zipfile.addFile(absolutePath, zipPath);
    }
  }
}

async function prepareOutputDir(outDir) {
  const existing = await stat(outDir).catch(() => undefined);
  if (existing === undefined) {
    await mkdir(outDir, { recursive: true });
    return;
  }
  if (!existing.isDirectory()) {
    throw new Error(`Output path exists and is not a directory: ${outDir}`);
  }
  const entries = await readdir(outDir);
  if (entries.length > 0 && !entries.includes(SENTINEL)) {
    throw new Error(
      `Refusing to overwrite non-generated output directory: ${outDir}\n` +
        `Choose an empty --out-dir or remove it manually.`,
    );
  }
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
}

function assertSafeOutputDir(pluginsRoot, outDir) {
  if (outDir === pluginsRoot) {
    throw new Error('Output directory must not be the plugins root.');
  }
  if (isWithin(pluginsRoot, outDir)) {
    throw new Error('Output directory must not contain the plugins root.');
  }
}

function resolveInsideRoot(root, input) {
  const resolved = resolve(root, input);
  if (!isWithin(resolved, root)) {
    throw new Error(`Path escapes root: ${input}`);
  }
  return resolved;
}

function isWithin(candidate, root) {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function isLocalRelativeSource(source) {
  const trimmed = source.trim();
  return (
    trimmed.length > 0 &&
    !trimmed.startsWith('http://') &&
    !trimmed.startsWith('https://') &&
    !trimmed.startsWith('file://') &&
    !trimmed.startsWith('/') &&
    !trimmed.startsWith('~/') &&
    trimmed !== '~'
  );
}

function withZipExtension(source) {
  const trimmed = source.trim().replace(/\/+$/, '');
  return extname(trimmed) === '.zip' ? trimmed : `${trimmed}.zip`;
}

function stripRelativePrefix(source) {
  return source.trim().replace(/^\.\//, '');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--plugins-root') {
      out.pluginsRoot = requiredValue(args, ++i, arg);
      continue;
    }
    if (arg === '--out-dir') {
      out.outDir = requiredValue(args, ++i, arg);
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function printHelp() {
  process.stdout.write(`Usage: pnpm run build:plugin-marketplace [-- --out-dir <dir>]\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`Build CDN-ready plugin marketplace artifacts.\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`Options:\n`);
  process.stdout.write(`  --plugins-root <dir>  Source plugins root. Default: ${DEFAULT_PLUGINS_ROOT}\n`);
  process.stdout.write(`  --out-dir <dir>       Output directory. Default: ${DEFAULT_OUT_DIR}\n`);
}
