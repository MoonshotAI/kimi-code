import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';

import { nativeJsBundlePath } from './paths.mjs';

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

function checkBundle(bundlePath) {
  if (!existsSync(bundlePath)) return [`bundle does not exist: ${bundlePath}`];
  const text = readFileSync(bundlePath, 'utf-8');
  const errors = [];

  const checkSpecifier = (specifier, kind) => {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      if (!optionalRelativeRuntimeRequires.has(specifier)) {
        errors.push(`relative ${kind} remains: ${specifier}`);
      }
      return;
    }
    if (!builtins.has(specifier) && !specifier.startsWith('node:') && !optionalRuntimeRequires.has(specifier)) {
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
  return errors;
}

const bundlePath = nativeJsBundlePath();
const errors = checkBundle(bundlePath);
if (errors.length > 0) {
  console.error(`Native JS bundle check failed for ${bundlePath}:`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
