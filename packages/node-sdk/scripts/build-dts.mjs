import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(import.meta.dirname, '..');
const tempDir = path.join(packageRoot, '.tmp-api-extractor');
const dtsRoot = path.join(tempDir, 'dts');
const providerClientShimPath = path.join(dtsRoot, 'provider-clients.d.ts');
const tscBinPath = packageBinPath('typescript', 'bin/tsc');
const apiExtractorBinPath = packageBinPath('@microsoft/api-extractor', 'bin/api-extractor');

const packageDirs = new Set(['agent-core', 'kaos', 'kosong', 'node-sdk', 'oauth']);
const workspacePackages = new Map([
  ['@moonshot-ai/agent-core', 'agent-core'],
  ['@moonshot-ai/kaos', 'kaos'],
  ['@moonshot-ai/kimi-code-oauth', 'oauth'],
  ['@moonshot-ai/kosong', 'kosong'],
]);

try {
  await rm(tempDir, { recursive: true, force: true });
  await run('tsc', tscBinPath, ['-p', 'tsconfig.dts.json']);
  await writeProviderClientShim();
  await rewriteWorkspaceSpecifiers();
  await run('api-extractor', apiExtractorBinPath, ['run', '--local']);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function packageBinPath(packageName, binPath) {
  return path.join(path.dirname(require.resolve(`${packageName}/package.json`)), binPath);
}

function run(command, binPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd: packageRoot,
      stdio: 'inherit',
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const detail = signal === null ? `exit code ${String(code)}` : `signal ${signal}`;
      reject(new Error(`${command} failed with ${detail}`));
    });
  });
}

async function writeProviderClientShim() {
  await mkdir(dtsRoot, { recursive: true });
  await writeFile(
    providerClientShimPath,
    [
      'export interface Anthropic {}',
      'export interface GoogleGenAI {}',
      'export interface OpenAI {}',
      'export namespace OpenAI {',
      '  export namespace Chat {',
      '    export type ChatCompletion = unknown;',
      '    export type ChatCompletionChunk = unknown;',
      '    export type ChatCompletionCreateParamsNonStreaming = unknown;',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
}

async function rewriteWorkspaceSpecifiers() {
  const files = await findDtsFiles(dtsRoot);
  const emittedFiles = new Set(files.map((file) => path.resolve(file)));

  await Promise.all(
    files.map(async (file) => {
      const packageDir = packageDirForFile(file);
      if (packageDir === undefined) {
        return;
      }

      const text = await readFile(file, 'utf8');
      const providerClientSpecifier = relativeSpecifier(file, providerClientShimPath);
      const providerClientText = text
        .replaceAll(
          "import Anthropic from '@anthropic-ai/sdk';",
          `import { Anthropic } from '${providerClientSpecifier}';`,
        )
        .replaceAll(
          "import OpenAI from 'openai';",
          `import { OpenAI } from '${providerClientSpecifier}';`,
        )
        .replaceAll(
          "import type OpenAI from 'openai';",
          `import type { OpenAI } from '${providerClientSpecifier}';`,
        )
        .replaceAll(
          "import { GoogleGenAI as GenAIClient } from '@google/genai';",
          `import { GoogleGenAI as GenAIClient } from '${providerClientSpecifier}';`,
        );
      const updated = providerClientText.replaceAll(
        /(["'])(#\/[^"']+|@moonshot-ai\/(?:agent-core|kaos|kimi-code-oauth|kosong)(?:\/[^"']+)?)\1/g,
        (_match, quote, specifier) => {
          const resolved = resolveSpecifier({
            currentFile: file,
            emittedFiles,
            packageDir,
            specifier,
          });

          return `${quote}${relativeSpecifier(file, resolved)}${quote}`;
        },
      );

      if (updated !== text) {
        await writeFile(file, updated);
      }
    }),
  );
}

async function findDtsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return findDtsFiles(entryPath);
      }
      return entry.name.endsWith('.d.ts') ? [entryPath] : [];
    }),
  );

  return files.flat();
}

function packageDirForFile(file) {
  const parts = path.relative(dtsRoot, file).split(path.sep);
  const [packageDir, firstDir] = parts;

  if (packageDir === undefined || firstDir !== 'src' || !packageDirs.has(packageDir)) {
    return undefined;
  }

  return packageDir;
}

function resolveSpecifier({ currentFile, emittedFiles, packageDir, specifier }) {
  if (specifier.startsWith('#/')) {
    return resolvePackageSubpath({
      emittedFiles,
      packageDir,
      subpath: specifier.slice(2),
      originalSpecifier: specifier,
    });
  }

  const workspacePackage = workspacePackageForSpecifier(specifier);
  if (workspacePackage === undefined) {
    throw new Error(`Unexpected workspace specifier in ${currentFile}: ${specifier}`);
  }

  return resolvePackageSubpath({
    emittedFiles,
    packageDir: workspacePackage.packageDir,
    subpath: workspacePackage.subpath,
    originalSpecifier: specifier,
  });
}

function workspacePackageForSpecifier(specifier) {
  for (const [packageName, packageDir] of workspacePackages) {
    if (specifier === packageName) {
      return { packageDir, subpath: 'index' };
    }

    const prefix = `${packageName}/`;
    if (specifier.startsWith(prefix)) {
      return { packageDir, subpath: specifier.slice(prefix.length) };
    }
  }

  return undefined;
}

function resolvePackageSubpath({ emittedFiles, packageDir, subpath, originalSpecifier }) {
  const srcRoot = path.join(dtsRoot, packageDir, 'src');
  const directFile = path.resolve(srcRoot, `${subpath}.d.ts`);
  if (emittedFiles.has(directFile) || existsSync(directFile)) {
    return directFile;
  }

  const indexFile = path.resolve(srcRoot, subpath, 'index.d.ts');
  if (emittedFiles.has(indexFile) || existsSync(indexFile)) {
    return indexFile;
  }

  throw new Error(`Unable to resolve ${originalSpecifier} in emitted declarations`);
}

function relativeSpecifier(fromFile, toFile) {
  const fromDir = path.dirname(fromFile);
  const withoutExtension = toFile.slice(0, -'.d.ts'.length);
  let relative = path.relative(fromDir, withoutExtension).replaceAll(path.sep, '/');

  if (!relative.startsWith('.')) {
    relative = `./${relative}`;
  }

  return relative;
}
