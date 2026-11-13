export const DEFAULT_MAX_FILES = 50000;
export const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024;
// Upper bound for the compressed codebase archive, aligned with the backend's
// per-upload limit. The scanner uses cumulative raw file size as a conservative
// estimate so the resulting zip stays within this bound.
export const DEFAULT_MAX_ARCHIVE_SIZE = 500 * 1024 * 1024;

const IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'coverage',
  '.nyc_output',
  'target',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.venv',
  'venv',
  'env',
  '.idea',
]);

const SENSITIVE_DIR_NAMES: ReadonlySet<string> = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.kube',
  '.docker',
]);

const SENSITIVE_FILE_NAMES: ReadonlySet<string> = new Set([
  '.env',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'credentials.json',
  'service-account.json',
  'serviceAccount.json',
  '.netrc',
  '.htpasswd',
  '.pypirc',
  '.npmrc',
  '.envrc',
  '.yarnrc',
  '.yarnrc.yml',
]);

const SENSITIVE_FILE_SUFFIXES: readonly string[] = [
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
];

const ENV_FILE_ALLOWED_SUFFIXES: ReadonlySet<string> = new Set(['.example', '.sample', '.template']);

export function isIgnoredDirName(name: string): boolean {
  return IGNORED_DIR_NAMES.has(name);
}

export function isSensitivePath(relativePath: string): boolean {
  const segments = relativePath.split('/');
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (segment !== undefined && SENSITIVE_DIR_NAMES.has(segment)) return true;
  }

  const base = segments.at(-1);
  if (base === undefined || base.length === 0) return false;
  if (SENSITIVE_FILE_NAMES.has(base)) return true;
  if (SENSITIVE_FILE_SUFFIXES.some((suffix) => base.endsWith(suffix))) return true;

  if (base.startsWith('.env.')) {
    const suffix = base.slice('.env'.length);
    return !ENV_FILE_ALLOWED_SUFFIXES.has(suffix);
  }

  return false;
}
