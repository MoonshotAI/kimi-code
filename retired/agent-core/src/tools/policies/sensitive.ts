/**
 * Sensitive-file detection.
 *
 * The pattern list is intentionally small to avoid false positives; files
 * matching any of these patterns are blocked from Read/Write/Edit so
 * credentials cannot be exfiltrated through a compromised prompt. Exemptions
 * like `.env.example` are explicitly allowed.
 */

import { basename } from 'pathe';

let nativeFn: ((path: string) => boolean) | undefined | null;

function getNative(): ((path: string) => boolean) | undefined {
  if (nativeFn === null) return undefined;
  if (nativeFn !== undefined) return nativeFn;
  try {
    const mod = require('@moonshot-ai/kimi-native-tools');
    nativeFn = typeof mod?.nativeIsSensitiveFile === 'function' ? mod.nativeIsSensitiveFile : null;
    return nativeFn ?? undefined;
  } catch {
    nativeFn = null;
    return undefined;
  }
}

const SENSITIVE_BASENAMES = new Set<string>([
  '.env',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'credentials',
  // Package manager credentials
  '.npmrc',
  '.pypirc',
  '.netrc',
  // Auth / password files
  'htpasswd',
  '.pgpass',
  '.git-credentials',
  // Key / certificate files
  '.ppk',
  '.p12',
  '.pfx',
  // Kubernetes
  'kubeconfig',
]);

const SENSITIVE_PATH_SUFFIXES = [
  ['.aws', 'credentials'],
  ['.gcp', 'credentials'],
  ['.docker', 'config.json'],
  ['.kube', 'config'],
  ['.config', 'kube', 'config'],
  ['.ssh', 'config'],
];

const ENV_PREFIX = '.env.';
const ENV_EXEMPTIONS = new Set<string>(['.env.example', '.env.sample', '.env.template']);

const SENSITIVE_BASENAME_PREFIXES = ['id_rsa', 'id_ed25519', 'id_ecdsa', 'credentials'];
const PUBLIC_KEY_BASENAMES = new Set<string>(['id_rsa.pub', 'id_ed25519.pub', 'id_ecdsa.pub']);
export const SENSITIVE_DOT_VARIANT_SUFFIXES = [
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

/**
 * Additional sensitive basename patterns that use a dot-extension style.
 * These are common private-key / certificate formats that don't share a
 * prefix with the `id_*` family.
 */
const SENSITIVE_KEYFILE_EXTENSIONS = new Set<string>([
  '.ppk',
  '.p12',
  '.pfx',
  '.keystore',
  '.jks',
]);

/**
 * Content-sniff markers — if a file's first non-whitespace bytes match
 * any of these patterns, it is almost certainly a private key regardless
 * of the filename. This is used as a secondary check by callers that
 * read file content.
 */
export const PRIVATE_KEY_MARKERS = [
  '-----BEGIN RSA PRIVATE KEY-----',
  '-----BEGIN EC PRIVATE KEY-----',
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  '-----BEGIN DSA PRIVATE KEY-----',
  '-----BEGIN PRIVATE KEY-----',
  '-----BEGIN ENCRYPTED PRIVATE KEY-----',
  '-----BEGIN PGP PRIVATE KEY BLOCK-----',
] as const;

/**
 * Quick check: does the start of a file's content look like a private key?
 * Callers that already have file content (e.g. Read tool) can use this as
 * a defense-in-depth check even when the filename doesn't match.
 */
export function looksLikePrivateKeyContent(content: string): boolean {
  const trimmed = content.slice(0, 200).trimStart();
  return PRIVATE_KEY_MARKERS.some((marker) => trimmed.startsWith(marker));
}
const SENSITIVE_DOT_VARIANT_SUFFIX_SET = new Set<string>(SENSITIVE_DOT_VARIANT_SUFFIXES);

function comparable(path: string): string {
  return path.toLowerCase();
}

export function isSensitiveFile(path: string): boolean {
  const fn = getNative();
  if (fn !== undefined) return fn(path);

  const name = basename(path);
  const comparableName = comparable(name);
  const comparablePath = comparable(path);

  if (ENV_EXEMPTIONS.has(comparableName)) return false;
  if (PUBLIC_KEY_BASENAMES.has(comparableName)) return false;
  if (SENSITIVE_BASENAMES.has(comparableName)) return true;
  if (comparableName.startsWith(ENV_PREFIX)) return true;

  for (const prefix of SENSITIVE_BASENAME_PREFIXES) {
    if (comparableName === prefix) return true;
    // Catch rename-shielded variants without flagging unrelated filenames
    // like `id_rsafoo` or ordinary JSON files like `credentials.json`.
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

  // Check keyfile-style extensions (e.g. `server.p12`, `mycert.pfx`)
  for (const ext of SENSITIVE_KEYFILE_EXTENSIONS) {
    if (comparableName.endsWith(ext)) return true;
  }

  return false;
}
