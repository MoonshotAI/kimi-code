import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { init as initModuleLexer, parse as parseModules } from 'es-module-lexer';

import { nativeIntermediatesDir, nativeJsBundlePath } from './paths.mjs';

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

const optionalRuntimeRequires = new Set([
  'ajv-formats/dist/formats',
  'ajv/dist/runtime/validation_error',
  'bufferutil',
  'canvas',
  'chokidar',
  'cpu-features',
  'fast-json-stringify/lib/serializer',
  'fast-json-stringify/lib/validator',
  'utf-8-validate',
]);
const optionalRelativeRuntimeRequires = new Set(['./crypto/build/Release/sshcrypto.node']);

function executableLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (line.length === 0) return false;
      if (line.startsWith('*') || line.startsWith('//') || line.startsWith('/*')) return false;
      return true;
    });
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

// Dynamic `import()` expressions found by a real lexer, so the `import(` text
// that bundled dependencies carry inside string literals and comments does not
// count. Node refuses to evaluate `import()` in a SEA main script that ships a
// V8 code cache (02-sea-blob.mjs), which is why tsdown.native.config.ts lowers
// them to `require()` and the main bundle must end up with none.
export async function findDynamicImports(text) {
  await initModuleLexer;
  const [imports] = parseModules(text);
  return imports
    .filter((entry) => entry.d >= 0)
    .map((entry) => ({ index: entry.ss, specifier: entry.n }));
}

export async function checkBundle(bundlePath, { worker = false } = {}) {
  if (!existsSync(bundlePath)) return [`bundle does not exist: ${bundlePath}`];
  const text = readFileSync(bundlePath, 'utf-8');
  const errors = [];
  const allowedExternal = worker ? new Set() : optionalRuntimeRequires;
  const allowedRelative = worker ? new Set() : optionalRelativeRuntimeRequires;

  const checkSpecifier = (specifier, kind) => {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      if (!allowedRelative.has(specifier)) errors.push(`relative ${kind} remains: ${specifier}`);
      return;
    }
    if (!builtins.has(specifier) && !specifier.startsWith('node:') && !allowedExternal.has(specifier)) {
      errors.push(`external ${kind} remains: ${specifier}`);
    }
  };

  for (const line of executableLines(text)) {
    for (const match of line.matchAll(/(?<![.\w])require\(\s*["']([^"']+)["']\s*\)/g)) {
      checkSpecifier(match[1], 'require');
    }
    for (const match of line.matchAll(/(?<![.\w])import\(\s*["']([^"']+)["']\s*\)/g)) {
      checkSpecifier(match[1], 'dynamic import');
    }
    if (line.startsWith('import ')) {
      for (const match of line.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
        checkSpecifier(match[1], 'import');
      }
      const sideEffect = line.match(/^import\s*["']([^"']+)["']/);
      if (sideEffect) checkSpecifier(sideEffect[1], 'import');
    }
  }

  if (!worker) {
    for (const { index, specifier } of await findDynamicImports(text)) {
      errors.push(
        `dynamic import() remains at line ${lineNumberAt(text, index)} (${specifier ?? 'non-literal specifier'}): ` +
          'the SEA code cache cannot load it',
      );
    }
  }
  return errors;
}

async function main() {
  const bundles = [
    { path: nativeJsBundlePath(), worker: false },
    { path: resolve(nativeIntermediatesDir(), 'text-build-worker.mjs'), worker: true },
    { path: resolve(nativeIntermediatesDir(), 'search-worker.mjs'), worker: true },
  ];
  let failed = false;
  for (const bundle of bundles) {
    const errors = await checkBundle(bundle.path, { worker: bundle.worker });
    if (errors.length === 0) continue;
    failed = true;
    console.error(`Native JS bundle check failed for ${bundle.path}:`);
    for (const error of errors) console.error(`- ${error}`);
  }
  if (failed) process.exit(1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
