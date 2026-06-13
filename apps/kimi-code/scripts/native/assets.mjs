import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { NATIVE_ASSET_MANIFEST_VERSION, buildManifestKey } from './manifest.mjs';
import { resolveTargetDeps, SUPPORTED_TARGETS } from './native-deps.mjs';

export { NATIVE_ASSET_MANIFEST_VERSION };

// Re-export for any external consumer that still needs it. Internally we
// use resolveTargetDeps() exclusively — no more if/else against package names.
export const NATIVE_TARGETS = Object.freeze(
  Object.fromEntries(
    SUPPORTED_TARGETS.map((t) => {
      const deps = resolveTargetDeps(t);
      const clipboardTarget = deps.find((d) => d.id === 'clipboard-target')?.resolvedName;
      return [t, { clipboardPackage: clipboardTarget }];
    }),
  ),
);

const jsExtensions = ['.js', '.cjs', '.mjs', '.json', '.node'];
const runtimeEntryNames = ['index.js', 'index.cjs', 'index.mjs'];

function fail(message) {
  throw new Error(message);
}

function toPosixPath(path) {
  return path.split('\\').join('/');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf-8'));
}

async function listFiles(root) {
  const files = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (entry.isFile()) {
        files.push(path);
      }
    }
  }

  await walk(root);
  return files;
}

function resolvePackageRootGeneric(requireFromApp, packageName, parentPackageName, appRoot, target) {
  try {
    return dirname(requireFromApp.resolve(`${packageName}/package.json`));
  } catch (rootError) {
    if (parentPackageName !== null) {
      try {
        const parentPackageJsonPath = realpathSync(
          requireFromApp.resolve(`${parentPackageName}/package.json`),
        );
        const requireFromParent = createRequire(pathToFileURL(parentPackageJsonPath));
        return dirname(requireFromParent.resolve(`${packageName}/package.json`));
      } catch {}
    }
    fail(
      [
        `Native asset package is not installed for target ${target}: ${packageName}`,
        parentPackageName ? `Searched via parent: ${parentPackageName}` : '',
        `Resolve root: ${appRoot}`,
        'Run pnpm install --frozen-lockfile before building native assets.',
        rootError instanceof Error ? rootError.message : String(rootError),
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
}

function resolveFileCandidate(path) {
  if (existsSync(path)) return path;
  for (const extension of jsExtensions) {
    const candidate = `${path}${extension}`;
    if (existsSync(candidate)) return candidate;
  }
  for (const entryName of runtimeEntryNames) {
    const candidate = join(path, entryName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolvePackageEntry(packageRoot, packageJson) {
  const rawMain =
    typeof packageJson.main === 'string'
      ? packageJson.main
      : typeof packageJson.module === 'string'
        ? packageJson.module
        : 'index.js';
  return resolveFileCandidate(resolve(packageRoot, rawMain));
}

function relativeRuntimeSpecifiers(text) {
  const specifiers = new Set();
  for (const match of text.matchAll(/\brequire\(\s*["'](\.[^"']+)["']\s*\)/g)) {
    specifiers.add(match[1]);
  }
  for (const match of text.matchAll(/(?<![.\w])import\(\s*["'](\.[^"']+)["']\s*\)/g)) {
    specifiers.add(match[1]);
  }
  for (const match of text.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) {
    specifiers.add(match[1]);
  }
  return [...specifiers];
}

async function addRuntimeDependencyFiles(packageRoot, filePath, selected) {
  const extension = extname(filePath);
  if (!['.js', '.cjs', '.mjs'].includes(extension)) return;

  let text;
  try {
    text = await readFile(filePath, 'utf-8');
  } catch {
    return;
  }

  for (const specifier of relativeRuntimeSpecifiers(text)) {
    const candidate = resolveFileCandidate(resolve(dirname(filePath), specifier));
    if (candidate === null) continue;
    if (candidate.endsWith('.node')) continue;
    const packageRelativePath = relative(packageRoot, candidate);
    if (
      packageRelativePath.startsWith('..') ||
      isAbsolute(packageRelativePath) ||
      packageRelativePath.length === 0
    ) {
      continue;
    }
    if (selected.has(candidate)) continue;
    selected.add(candidate);
    await addRuntimeDependencyFiles(packageRoot, candidate, selected);
  }
}

async function collectPackageFiles({
  packageName,
  packageRoot,
  includeNativeFiles,
  nativeFileRelatives = [],
}) {
  const packageJsonPath = join(packageRoot, 'package.json');
  const packageJson = await readJson(packageJsonPath);
  const selected = new Set([packageJsonPath]);

  const entry = resolvePackageEntry(packageRoot, packageJson);
  if (entry !== null) {
    selected.add(entry);
    await addRuntimeDependencyFiles(packageRoot, entry, selected);
  }

  for (const nativeFileRelative of nativeFileRelatives) {
    const nativeFile = resolve(packageRoot, nativeFileRelative);
    if (!existsSync(nativeFile)) {
      fail(`Native package ${packageName} does not contain ${nativeFileRelative} at ${packageRoot}`);
    }
    selected.add(nativeFile);
  }

  if (includeNativeFiles) {
    const files = await listFiles(packageRoot);
    for (const file of files) {
      if (file.endsWith('.node')) {
        selected.add(file);
      }
    }
  }

  const sorted = [...selected].sort((a, b) => a.localeCompare(b));
  if (includeNativeFiles && !sorted.some((file) => file.endsWith('.node'))) {
    fail(`Native package ${packageName} does not contain a .node file at ${packageRoot}`);
  }
  return sorted;
}

async function packageManifestEntries({ packageName, packageRoot, files, target }) {
  const root = `node_modules/${packageName}`;
  const entries = [];
  const assets = {};

  for (const file of files) {
    const sourceBytes = await readFile(file);
    const packageRelativePath = toPosixPath(relative(packageRoot, file));
    const relativePath = `${root}/${packageRelativePath}`;
    const assetKey = `native/${target}/${relativePath}`;
    entries.push({
      assetKey,
      relativePath,
      sha256: sha256(sourceBytes),
    });
    assets[assetKey] = file;
  }

  return {
    packageManifest: {
      name: packageName,
      root,
      files: entries,
    },
    assets,
  };
}

export const nativeAssetManifestKey = buildManifestKey;

export function nativeAssetSummary(manifest) {
  return manifest.packages.map((pkg) => `${pkg.name}: ${pkg.files.length} files`);
}

export async function collectNativeAssets({ appRoot, target }) {
  const requireFromApp = createRequire(pathToFileURL(resolve(appRoot, 'package.json')));
  const targetDeps = resolveTargetDeps(target); // throws on unsupported target

  const manifestPackages = [];
  const assets = {};

  for (const dep of targetDeps) {
    const packageRoot = resolvePackageRootGeneric(
      requireFromApp,
      dep.resolvedName,
      dep.parentName,
      appRoot,
      target,
    );
    const files = await collectPackageFiles({
      packageName: dep.resolvedName,
      packageRoot,
      includeNativeFiles: dep.collect === 'native-files',
      nativeFileRelatives: dep.nativeFileRelatives,
    });
    const result = await packageManifestEntries({
      packageName: dep.resolvedName,
      packageRoot,
      files,
      target,
    });
    manifestPackages.push(result.packageManifest);
    Object.assign(assets, result.assets);
  }

  const manifest = {
    version: NATIVE_ASSET_MANIFEST_VERSION,
    target,
    packages: manifestPackages,
  };

  return {
    manifest,
    manifestJson: `${JSON.stringify(manifest, null, 2)}\n`,
    assets,
  };
}
