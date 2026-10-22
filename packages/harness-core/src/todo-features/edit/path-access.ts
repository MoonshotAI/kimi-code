import { homedir } from 'node:os';

import { basename, isAbsolute, join, normalize, resolve } from 'pathe';

const SENSITIVE_BASENAMES = new Set<string>([
  '.env',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'credentials',
]);

const SENSITIVE_PATH_SUFFIXES = [
  ['.aws', 'credentials'],
  ['.gcp', 'credentials'],
];

const ENV_PREFIX = '.env.';
const ENV_EXEMPTIONS = new Set<string>(['.env.example', '.env.sample', '.env.template']);

const SENSITIVE_BASENAME_PREFIXES = ['id_rsa', 'id_ed25519', 'id_ecdsa', 'credentials'];
const PUBLIC_KEY_BASENAMES = new Set<string>(['id_rsa.pub', 'id_ed25519.pub', 'id_ecdsa.pub']);
const SENSITIVE_DOT_VARIANT_SUFFIXES = [
  '.bak',
  '.backup',
  '.copy',
  '.disabled',
  '.key',
  '.old',
  '.orig',
  '.pem',
  '.save',
  '.tmp',
] as const;
const SENSITIVE_DOT_VARIANT_SUFFIX_SET = new Set<string>(SENSITIVE_DOT_VARIANT_SUFFIXES);

function comparable(path: string): string {
  return path.toLowerCase();
}

export function isSensitiveFile(path: string): boolean {
  const name = basename(path);
  const comparableName = comparable(name);
  const comparablePath = comparable(path);

  if (ENV_EXEMPTIONS.has(comparableName)) return false;
  if (PUBLIC_KEY_BASENAMES.has(comparableName)) return false;
  if (SENSITIVE_BASENAMES.has(comparableName)) return true;
  if (comparableName.startsWith(ENV_PREFIX)) return true;

  for (const prefix of SENSITIVE_BASENAME_PREFIXES) {
    if (comparableName === prefix) return true;
    if (comparableName.length > prefix.length && comparableName.startsWith(prefix)) {
      const suffix = comparableName.slice(prefix.length);
      const next = suffix[0];
      if (next === '-' || next === '_') return true;
      if (next === '.' && SENSITIVE_DOT_VARIANT_SUFFIX_SET.has(suffix)) return true;
    }
  }

  for (const suffixParts of SENSITIVE_PATH_SUFFIXES) {
    const suffix = suffixParts.join('/');
    const comparableSuffix = comparable(suffix);
    if (
      comparablePath.endsWith(`/${comparableSuffix}`) ||
      comparablePath.includes(`/${comparableSuffix}/`)
    ) {
      return true;
    }
  }

  return false;
}

export class PathSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathSecurityError';
  }
}

function expandUserPath(path: string, homeDir: string | undefined): string {
  if (homeDir === undefined) return path;
  if (path === '~') return homeDir;
  if (path.startsWith('~/') || (process.platform === 'win32' && path.startsWith('~\\'))) {
    return join(homeDir, path.slice(2));
  }
  return path;
}

function isWithinDirectory(candidate: string, base: string): boolean {
  const nc = normalize(candidate);
  const nb = normalize(base);
  const comparableCandidate = process.platform === 'win32' ? nc.toLowerCase() : nc;
  const comparableBase = process.platform === 'win32' ? nb.toLowerCase() : nb;
  if (comparableCandidate === comparableBase) return true;
  const prefix = comparableBase.endsWith('/') ? comparableBase : comparableBase + '/';
  return comparableCandidate.startsWith(prefix);
}

export function resolveEditPath(path: string, workDir: string): string {
  const expanded = expandUserPath(path, homedir());
  const rawIsAbsolute = isAbsolute(expanded);
  const canonical = normalize(isAbsolute(expanded) ? expanded : resolve(workDir, expanded));
  if (isSensitiveFile(canonical)) {
    throw new PathSecurityError(
      `"${path}" matches a sensitive-file pattern (env / credential / SSH key). ` +
        'Access is blocked to protect secrets.',
    );
  }
  if (!rawIsAbsolute && !isWithinDirectory(canonical, workDir)) {
    throw new PathSecurityError(
      `"${path}" is not an absolute path. ` +
        'You must provide an absolute path to write or edit a file outside the working directory.',
    );
  }
  return canonical;
}
