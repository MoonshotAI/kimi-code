import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

import { getHostPackageRoot } from '#/cli/version';
import { resolveCommandPath } from '#/utils/process/resolve-command';

import { NPM_PACKAGE_NAME, type InstallSource } from './types';

const nodeRequire = createRequire(import.meta.url);

interface NodeSeaModule {
  isSea(): boolean;
}

let cachedSea: NodeSeaModule | null | undefined;

function loadSeaModule(): NodeSeaModule | null {
  if (cachedSea !== undefined) return cachedSea;
  try {
    cachedSea = nodeRequire('node:sea') as NodeSeaModule;
  } catch {
    cachedSea = null;
  }
  return cachedSea;
}

export function detectNativeInstall(): boolean {
  const sea = loadSeaModule();
  if (sea === null) return false;
  try {
    return sea.isSea();
  } catch {
    return false;
  }
}

const PNPM_PATH_SEGMENT = 'pnpm/global/';
const YARN_PATH_SEGMENTS = ['.config/yarn/global/', '/.yarn/global/'];
const BUN_PATH_SEGMENT = '.bun/install/global/';
const HOMEBREW_PATH_SEGMENT = '/cellar/';

function normalizeForHeuristic(filePath: string): string {
  return filePath.replaceAll('\\', '/').toLowerCase();
}

export function classifyByPathHeuristic(packageRoot: string): InstallSource | null {
  const normalized = normalizeForHeuristic(packageRoot);
  if (normalized.includes(PNPM_PATH_SEGMENT)) return 'pnpm-global';
  for (const seg of YARN_PATH_SEGMENTS) {
    if (normalized.includes(seg)) return 'yarn-global';
  }
  if (normalized.includes(BUN_PATH_SEGMENT)) return 'bun-global';
  if (normalized.includes(HOMEBREW_PATH_SEGMENT)) return 'homebrew';
  return null;
}

export interface DetectInstallSourceDeps {
  readonly getPackageRoot: () => string;
  readonly getGlobalPrefix: () => Promise<string>;
  readonly detectNative: () => boolean;
  readonly platform: NodeJS.Platform;
  readonly allowGlobalPrefix?: boolean;
}

function npmCommand(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function npmGlobalPrefix(platform: NodeJS.Platform): Promise<string> {
  const resolved = resolveCommandPath(npmCommand(platform));
  if (resolved === undefined) {
    return Promise.reject(new Error('npm was not found in PATH'));
  }
  return execFileText(resolved, ['prefix', '-g']).then((text) => text.trim());
}

function execFileText(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(command, [...args], { encoding: 'utf-8' }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolveOutput(stdout);
    });
  });
}

function normalizePathForComparison(filePath: string, platform: NodeJS.Platform): string | null {
  const trimmed = filePath.trim();
  if (trimmed.length === 0) return null;
  try {
    return normalizeResolvedPath(realpathSync(trimmed), platform);
  } catch {
    return normalizeResolvedPath(resolve(trimmed), platform);
  }
}

function normalizeResolvedPath(filePath: string, platform: NodeJS.Platform): string {
  const resolvedPath = resolve(filePath);
  return platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
}

function candidateGlobalPackageDirs(
  globalPrefix: string,
  platform: NodeJS.Platform,
): readonly string[] {
  if (platform === 'win32') {
    return [join(globalPrefix, 'node_modules', NPM_PACKAGE_NAME)];
  }
  return [
    join(globalPrefix, 'lib', 'node_modules', NPM_PACKAGE_NAME),
    join(globalPrefix, 'node_modules', NPM_PACKAGE_NAME),
  ];
}

export function classifyInstallSource(
  packageRoot: string,
  globalPrefix: string,
  platform: NodeJS.Platform = process.platform,
): InstallSource {
  const normalizedPackageRoot = normalizePathForComparison(packageRoot, platform);
  if (normalizedPackageRoot === null) return 'unsupported';

  for (const candidate of candidateGlobalPackageDirs(globalPrefix, platform)) {
    if (normalizePathForComparison(candidate, platform) === normalizedPackageRoot) {
      return 'npm-global';
    }
  }
  return 'unsupported';
}

export function detectInstallSource(
  deps: Partial<DetectInstallSourceDeps> & { readonly allowGlobalPrefix: false },
): Promise<InstallSource | null>;
export function detectInstallSource(
  deps?: Partial<Omit<DetectInstallSourceDeps, 'allowGlobalPrefix'>> & {
    readonly allowGlobalPrefix?: true;
  },
): Promise<InstallSource>;
export function detectInstallSource(
  deps: Partial<DetectInstallSourceDeps> & { readonly allowGlobalPrefix: boolean },
): Promise<InstallSource | null>;
export function detectInstallSource(
  deps?: Partial<DetectInstallSourceDeps>,
): Promise<InstallSource | null>;
export async function detectInstallSource(
  deps: Partial<DetectInstallSourceDeps> = {},
): Promise<InstallSource | null> {
  const platform = deps.platform ?? process.platform;
  const resolved: DetectInstallSourceDeps = {
    getPackageRoot: deps.getPackageRoot ?? getHostPackageRoot,
    getGlobalPrefix:
      deps.getGlobalPrefix ??
      (() => npmGlobalPrefix(platform)),
    detectNative: deps.detectNative ?? detectNativeInstall,
    platform,
    allowGlobalPrefix: deps.allowGlobalPrefix ?? true,
  };

  if (resolved.detectNative()) return 'native';

  const packageRoot = resolved.getPackageRoot();
  const heuristic = classifyByPathHeuristic(packageRoot);
  if (heuristic !== null || !resolved.allowGlobalPrefix) return heuristic;

  try {
    const globalPrefix = await resolved.getGlobalPrefix();
    return classifyInstallSource(packageRoot, globalPrefix, resolved.platform);
  } catch {
    return 'unsupported';
  }
}
