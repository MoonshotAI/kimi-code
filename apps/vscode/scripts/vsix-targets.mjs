import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VSIX_TARGETS = Object.freeze([
  'darwin-x64',
  'darwin-arm64',
  'linux-x64',
  'linux-arm64',
  'win32-x64',
  'win32-arm64',
]);

export const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const defaultVsixOutputDir = join(extensionRoot, 'artifacts', 'vsix');

export function vsixFileName(target) {
  assertVsixTarget(target);
  return `kimi-code-${target}.vsix`;
}

export function normalizeVsixTargets(values) {
  const requested = values.length === 0 || values.includes('all') ? VSIX_TARGETS : values;
  if (values.includes('all') && values.length > 1) {
    throw new Error('Target "all" cannot be combined with an explicit VSIX target.');
  }

  const targets = [];
  for (const target of requested) {
    assertVsixTarget(target);
    if (!targets.includes(target)) targets.push(target);
  }
  return targets;
}

export function assertVsixTarget(target) {
  if (VSIX_TARGETS.includes(target)) return;
  throw new Error(
    `Unknown VSIX target "${target}". Expected one of: ${VSIX_TARGETS.join(', ')}`,
  );
}

export function isMainModule(metaUrl) {
  const argvPath = process.argv[1];
  return argvPath !== undefined && pathToFileURL(resolve(argvPath)).href === metaUrl;
}
